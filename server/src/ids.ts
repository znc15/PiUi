import { randomBytes } from 'node:crypto'

function base62(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

export function id(prefix: string): string {
  return `${prefix}_${base62(12)}`
}

export const newSessionId = () => id('ses')
export const newMessageId = () => id('msg')
export const newPartId = () => id('prt')
export const newProjectId = () => id('prj')
export const newPtyId = () => id('pty')
export const newPermissionId = () => id('per')
