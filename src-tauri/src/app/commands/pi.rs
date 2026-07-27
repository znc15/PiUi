// ============================================
// Pi runtime detection + bridge service management (desktop only)
//
// - detect_pi_environment: find Node.js / pi CLI (GUI apps on macOS
//   get a minimal PATH, so we also scan Homebrew / nvm / fnm / volta)
// - start_pi_service: spawn the bundled Pi bridge (single-file ESM)
//   with the user's own Node runtime and wait for its health endpoint
// - stop / check / close helpers
// ============================================

use crate::app::service::ServiceState;
use serde::Serialize;
use std::{
    collections::VecDeque,
    env,
    ffi::OsString,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::Ordering, mpsc},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiEnvironment {
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub pi_path: Option<String>,
    pub pi_version: Option<String>,
    pub bridge_script: Option<String>,
    /// "bundle" (packaged resources) or "tsx-dev" (repo sources)
    pub bridge_mode: Option<String>,
    /// Pi agent dir (~/.pi/agent or PI_AGENT_DIR)
    pub agent_dir: String,
    /// provider names found in auth.json (names only, never secrets)
    pub auth_providers: Vec<String>,
    /// true when auth.json has entries or a known API key env var is set
    pub authed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPiServiceResult {
    pub started: bool,
    pub started_by_us: bool,
    pub url: Option<String>,
}

struct SpawnedBridge {
    child: Child,
    output: mpsc::Receiver<String>,
}

// ============================================
// Executable discovery
// ============================================

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

/// Compare dotted version strings ("v22.22.3" vs "v20.1.0").
fn compare_version_strings(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(s: &str) -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|part| part.parse::<u64>().ok())
            .collect()
    }
    parse(a).cmp(&parse(b))
}

/// Extra bin directories GUI apps typically miss on macOS
/// (launchd gives them only /usr/bin:/bin:/usr/sbin:/sbin).
fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/opt/local/bin"),
    ];

    if let Some(home) = home_dir() {
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".fnm/aliases/default/bin"));
        dirs.push(home.join(".asdf/shims"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".deno/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".local/bin"));

        // nvm: scan installed versions, newest first
        let nvm_root = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(nvm_root) {
            let mut versions: Vec<(String, PathBuf)> = entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.join("bin").is_dir())
                .map(|path| {
                    let name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("")
                        .to_string();
                    (name, path)
                })
                .collect();
            versions.sort_by(|a, b| compare_version_strings(&b.0, &a.0));
            for (_name, path) in versions.into_iter().take(3) {
                dirs.push(path.join("bin"));
            }
        }
    }

    dirs
}

/// All directories to search: user env PATH override → process PATH → extras.
fn search_dirs(env_vars: &std::collections::HashMap<String, String>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    let mut push_paths = |value: &str| {
        for dir in env::split_paths(value) {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    };

    if let Some(path_value) = env_vars.get("PATH").or_else(|| env_vars.get("Path")) {
        push_paths(path_value);
    }
    if let Ok(path_value) = env::var("PATH") {
        push_paths(&path_value);
    }
    for dir in extra_bin_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }

    dirs
}

fn find_executable(
    name: &str,
    env_vars: &std::collections::HashMap<String, String>,
) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };

    for dir in search_dirs(env_vars) {
        for candidate_name in &names {
            let candidate = dir.join(candidate_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

/// Run `<program> <args...>` and capture the first stdout line (5s timeout).
fn run_version_command(program: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(line) => {
            let _ = child.wait();
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => {
            let _ = child.kill();
            None
        }
    }
}

fn resolve_node(
    env_vars: &std::collections::HashMap<String, String>,
    preferred: Option<&str>,
) -> Option<(PathBuf, Option<String>)> {
    if let Some(pref) = preferred.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(pref);
        if path.is_file() {
            let version = run_version_command(&path, &["--version"]);
            return Some((path, version));
        }
        log::warn!("Configured node path not found: {pref}");
    }

    let path = find_executable("node", env_vars)?;
    let version = run_version_command(&path, &["--version"]);
    Some((path, version))
}

fn resolve_pi(
    env_vars: &std::collections::HashMap<String, String>,
) -> Option<(PathBuf, Option<String>)> {
    let path = find_executable("pi", env_vars)?;
    let version = run_version_command(&path, &["--version"]);
    Some((path, version))
}

/// Locate the bridge entry script:
/// 1. packaged resource (release builds)
/// 2. repo sources via tsx (dev builds)
fn resolve_bridge_script(app: &AppHandle) -> Option<(PathBuf, &'static str)> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        for rel in ["resources/pi-bridge/index.mjs", "pi-bridge/index.mjs"] {
            let candidate = resource_dir.join(rel);
            if candidate.is_file() {
                // Tauri 在 Windows 上返回带 `\\?\` 前缀的 verbatim 路径，
                // Node.js 无法以此前缀加载入口脚本（会退化成 lstat 'C:' → EISDIR）。
                return Some((dunce::simplified(&candidate).to_path_buf(), "bundle"));
            }
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let ts_entry = manifest
        .join("..")
        .join("server")
        .join("src")
        .join("index.ts");
    if ts_entry.is_file() {
        // dunce::canonicalize 规范化路径但不加 `\\?\` 前缀（std 的 canonicalize 会加）。
        let resolved = dunce::canonicalize(&ts_entry).unwrap_or(ts_entry);
        return Some((resolved, "tsx-dev"));
    }

    None
}

// ============================================
// Commands
// ============================================

/// Well-known provider API key env vars (names only, values never read out).
const KNOWN_API_KEY_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ZHIPU_AI_API_KEY",
    "MOONSHOT_API_KEY",
    "DASHSCOPE_API_KEY",
    "DEEPSEEK_API_KEY",
    "CEREBRAS_API_KEY",
];

/// Read Pi auth status directly from ~/.pi/agent/auth.json.
/// Works without a running bridge, so the UI can show auth state even
/// when the service is stopped or an outdated external service is used.
fn detect_pi_auth(
    env_vars: &std::collections::HashMap<String, String>,
) -> (String, Vec<String>, bool) {
    let agent_dir = env_vars
        .get("PI_AGENT_DIR")
        .cloned()
        .or_else(|| env::var("PI_AGENT_DIR").ok())
        .or_else(|| {
            home_dir().map(|h| h.join(".pi").join("agent").to_string_lossy().to_string())
        })
        .unwrap_or_default();

    let mut providers: Vec<String> = Vec::new();
    if !agent_dir.is_empty() {
        let auth_path = Path::new(&agent_dir).join("auth.json");
        if let Ok(raw) = std::fs::read_to_string(auth_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(obj) = json.as_object() {
                    providers = obj.keys().cloned().collect();
                    providers.sort();
                }
            }
        }
    }

    // models.json 里的自定义 provider（如自建 gateway，内嵌 apiKey/baseUrl）也视为已配置
    if !agent_dir.is_empty() {
        let models_path = Path::new(&agent_dir).join("models.json");
        if let Ok(raw) = std::fs::read_to_string(models_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(obj) = json.get("providers").and_then(|p| p.as_object()) {
                    for key in obj.keys() {
                        if !providers.contains(key) {
                            providers.push(key.clone());
                        }
                    }
                }
            }
        }
        providers.sort();
    }

    let has_env_key = KNOWN_API_KEY_VARS.iter().any(|key| {
        env_vars
            .get(*key)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
            || env::var(key).map(|v| !v.trim().is_empty()).unwrap_or(false)
    });

    let authed = !providers.is_empty() || has_env_key;
    (agent_dir, providers, authed)
}

/// Detect Node.js, pi CLI and the bundled bridge script.
#[tauri::command]
pub async fn detect_pi_environment(
    app: AppHandle,
    env_vars: std::collections::HashMap<String, String>,
) -> Result<PiEnvironment, String> {
    let node = resolve_node(&env_vars, None);
    let pi = resolve_pi(&env_vars);
    let bridge = resolve_bridge_script(&app);
    let (agent_dir, auth_providers, authed) = detect_pi_auth(&env_vars);

    Ok(PiEnvironment {
        node_path: node.as_ref().map(|(p, _)| p.to_string_lossy().to_string()),
        node_version: node.and_then(|(_, version)| version),
        pi_path: pi.as_ref().map(|(p, _)| p.to_string_lossy().to_string()),
        pi_version: pi.and_then(|(_, version)| version),
        bridge_script: bridge.as_ref().map(|(p, _)| p.to_string_lossy().to_string()),
        bridge_mode: bridge.map(|(_, mode)| mode.to_string()),
        agent_dir,
        auth_providers,
        authed,
    })
}

/// Check whether a bridge service answers its health endpoint.
pub async fn is_service_running(url: &str) -> bool {
    let health_url = format!("{}/global/health", url.trim_end_matches('/'));
    match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client
            .get(&health_url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn check_pi_service(url: String) -> Result<bool, String> {
    Ok(is_service_running(&url).await)
}

// ============================================
// Bridge process lifecycle
// ============================================

/// Build the child environment: current env + fixed PATH (node dir,
/// Homebrew, nvm, …) + user-provided overrides.
fn build_child_env(
    env_vars: &std::collections::HashMap<String, String>,
    node_path: &Path,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = env::vars_os().collect();

    let mut path_parts: Vec<PathBuf> = Vec::new();
    if let Some(dir) = node_path.parent() {
        path_parts.push(dir.to_path_buf());
    }
    path_parts.extend(extra_bin_dirs());

    let existing_path = env_vars
        .get("PATH")
        .or_else(|| env_vars.get("Path"))
        .cloned()
        .or_else(|| env::var("PATH").ok());
    if let Some(value) = existing_path {
        for dir in env::split_paths(&value) {
            path_parts.push(dir);
        }
    }

    let joined = env::join_paths(&path_parts).unwrap_or_default();
    env.retain(|(key, _)| key != "PATH" && key != "Path");
    env.push((OsString::from("PATH"), joined));

    for (key, value) in env_vars {
        env.push((OsString::from(key.clone()), OsString::from(value.clone())));
    }

    env
}

fn spawn_output_reader<R>(reader: R, tx: mpsc::Sender<String>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut tx = Some(tx);
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if let Some(sender) = tx.as_ref() {
                if sender.send(line).is_err() {
                    tx = None;
                }
            }
        }
    });
}

fn spawn_bridge(
    node_path: &Path,
    script: &Path,
    mode: &str,
    env: &[(OsString, OsString)],
    port: u16,
) -> Result<SpawnedBridge, String> {
    log::info!(
        "Starting Pi bridge (mode={mode}) node={} script={}",
        node_path.display(),
        script.display()
    );

    let mut cmd = if mode == "tsx-dev" {
        // script = <repo>/server/src/index.ts → server dir is two levels up
        let server_dir = script
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .ok_or_else(|| "Cannot resolve server directory for dev mode".to_string())?;
        let tsx_cli = server_dir
            .join("node_modules")
            .join("tsx")
            .join("dist")
            .join("cli.mjs");
        if !tsx_cli.is_file() {
            return Err(
                "Dev mode: tsx not found. Run `npm --prefix server install` first.".to_string(),
            );
        }
        let mut c = Command::new(node_path);
        c.arg(&tsx_cli).arg(script);
        c.current_dir(server_dir);
        c
    } else {
        let mut c = Command::new(node_path);
        c.arg(script);
        c
    };

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env_clear();
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.env("PORT", port.to_string());
    cmd.env("HOST", "127.0.0.1");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Pi bridge: {e}"))?;

    let (tx, output) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        spawn_output_reader(stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_output_reader(stderr, tx);
    }

    Ok(SpawnedBridge { child, output })
}

fn parse_listening_url(line: &str) -> Option<String> {
    let start = line.find("http://").or_else(|| line.find("https://"))?;
    let raw_url = line[start..]
        .split_whitespace()
        .next()?
        .trim_end_matches([',', ';', ')']);
    let normalized = raw_url
        .replace("http://0.0.0.0:", "http://127.0.0.1:")
        .replace("https://0.0.0.0:", "https://127.0.0.1:");
    let parsed = reqwest::Url::parse(&normalized).ok()?;

    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn remember_recent_output(recent_output: &mut VecDeque<String>, line: String) {
    if recent_output.len() >= 12 {
        recent_output.pop_front();
    }
    recent_output.push_back(line);
}

fn format_recent_output(recent_output: &VecDeque<String>) -> String {
    if recent_output.is_empty() {
        return String::new();
    }

    format!(
        " Recent output: {}",
        recent_output
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ")
    )
}

/// Start the Pi bridge (unless one is already healthy).
#[tauri::command]
pub async fn start_pi_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
    url: String,
    node_path: String,
    env_vars: std::collections::HashMap<String, String>,
) -> Result<StartPiServiceResult, String> {
    if state.we_started.load(Ordering::SeqCst) {
        let current_url = state.service_url.lock().map_err(|e| e.to_string())?.clone();
        if let Some(current_url) = current_url {
            if is_service_running(&current_url).await {
                log::info!("Pi bridge already running at {current_url}");
                return Ok(StartPiServiceResult {
                    started: false,
                    started_by_us: true,
                    url: Some(current_url),
                });
            }
        }
    }

    if is_service_running(&url).await {
        log::info!("Pi bridge already running at {url}");
        return Ok(StartPiServiceResult {
            started: false,
            started_by_us: false,
            url: Some(url),
        });
    }

    let (script, mode) = resolve_bridge_script(&app).ok_or_else(|| {
        "Pi bridge script not found. Release builds bundle it automatically; \
         for development run `npm run build:bridge` or start `npm run dev:server` manually."
            .to_string()
    })?;

    let preferred = if node_path.trim().is_empty() {
        None
    } else {
        Some(node_path.trim())
    };
    let (node, node_version) = resolve_node(&env_vars, preferred).ok_or_else(|| {
        "Node.js not found. Install Node 20+ (e.g. `brew install node`) \
         or set the node path in Settings → Local Service."
            .to_string()
    })?;
    if let Some(version) = &node_version {
        log::info!("Using node {} ({})", version, node.display());
    }

    let port = reqwest::Url::parse(&url)
        .ok()
        .and_then(|parsed| parsed.port())
        .unwrap_or(4096);

    let env = build_child_env(&env_vars, &node);
    let mut spawned = spawn_bridge(&node, &script, mode, &env, port)?;
    let pid = spawned.child.id();
    log::info!("Pi bridge spawned, PID: {pid}");

    state.child_pid.store(pid, Ordering::SeqCst);
    state.we_started.store(true, Ordering::SeqCst);
    *state.service_url.lock().map_err(|e| e.to_string())? = None;

    let mut detected_url: Option<String> = None;
    let mut recent_output = VecDeque::new();

    for _ in 0..60 {
        while let Ok(line) = spawned.output.try_recv() {
            log::info!("[pi-bridge] {line}");
            if let Some(parsed_url) = parse_listening_url(&line) {
                log::info!("Detected Pi bridge URL: {parsed_url}");
                *state.service_url.lock().map_err(|e| e.to_string())? = Some(parsed_url.clone());
                detected_url = Some(parsed_url);
            }
            remember_recent_output(&mut recent_output, line);
        }

        if let Some(status) = spawned.child.try_wait().map_err(|e| e.to_string())? {
            state.child_pid.store(0, Ordering::SeqCst);
            state.we_started.store(false, Ordering::SeqCst);
            *state.service_url.lock().map_err(|e| e.to_string())? = None;
            return Err(format!(
                "Pi bridge exited during startup with status {}.{}",
                status,
                format_recent_output(&recent_output)
            ));
        }

        let health_target = detected_url.clone().unwrap_or_else(|| url.clone());
        if is_service_running(&health_target).await {
            log::info!("Pi bridge is ready at {health_target}");
            *state.service_url.lock().map_err(|e| e.to_string())? = Some(health_target.clone());
            return Ok(StartPiServiceResult {
                started: true,
                started_by_us: true,
                url: Some(health_target),
            });
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    log::warn!("Pi bridge started but health check not passing yet");
    Ok(StartPiServiceResult {
        started: true,
        started_by_us: true,
        url: detected_url,
    })
}

/// Kill a process by PID (cross-platform).
pub fn kill_process_by_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

/// Stop the bridge we started (if any).
#[tauri::command]
pub async fn stop_pi_service(state: State<'_, ServiceState>) -> Result<(), String> {
    let pid = state.child_pid.swap(0, Ordering::SeqCst);
    state.we_started.store(false, Ordering::SeqCst);
    *state.service_url.lock().map_err(|e| e.to_string())? = None;

    if pid > 0 {
        log::info!("Stopping Pi bridge, PID: {pid}");
        kill_process_by_pid(pid);
    }

    Ok(())
}

/// Whether this app instance started the bridge.
#[tauri::command]
pub async fn get_service_started_by_us(state: State<'_, ServiceState>) -> Result<bool, String> {
    Ok(state.we_started.load(Ordering::SeqCst))
}

/// Confirm closing the window, optionally stopping the bridge.
#[tauri::command]
pub async fn confirm_close_app(
    window: tauri::Window,
    state: State<'_, ServiceState>,
    stop_service: bool,
) -> Result<(), String> {
    if stop_service {
        let pid = state.child_pid.swap(0, Ordering::SeqCst);
        if pid > 0 {
            log::info!("Closing app and stopping Pi bridge, PID: {pid}");
            kill_process_by_pid(pid);
        }
        state.we_started.store(false, Ordering::SeqCst);
        *state.service_url.lock().map_err(|e| e.to_string())? = None;
    } else {
        log::info!("Closing app, keeping Pi bridge running");
    }

    window.destroy().map_err(|e| e.to_string())
}
