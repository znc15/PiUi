import type { TodoItem } from '../types/api/event'

interface RawTodo {
  content?: string
  status?: string
  priority?: string
  id?: string
}

function buildTodoId(todo: RawTodo, index: number): string {
  if (todo.id) return todo.id
  const content = String(todo.content ?? '').slice(0, 32)
  const status = String(todo.status ?? '')
  const priority = String(todo.priority ?? '')
  return `todo-${index}-${content}-${status}-${priority}`
}

function isTodoStatus(status: string): status is TodoItem['status'] {
  return status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled'
}

function isTodoPriority(priority: string): priority is TodoItem['priority'] {
  return priority === 'high' || priority === 'medium' || priority === 'low'
}

function normalizeTodoStatus(status: string): TodoItem['status'] {
  return isTodoStatus(status) ? status : 'pending'
}

function normalizeTodoPriority(priority: string): TodoItem['priority'] {
  return isTodoPriority(priority) ? priority : 'medium'
}

export function normalizeTodoItems(todos: RawTodo[] | null | undefined): TodoItem[] {
  return (todos ?? []).map((todo, index) => ({
    id: buildTodoId(todo, index),
    content: todo.content ?? '',
    status: normalizeTodoStatus(todo.status ?? 'pending'),
    priority: normalizeTodoPriority(todo.priority ?? 'medium'),
  }))
}
