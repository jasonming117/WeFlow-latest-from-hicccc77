import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { ConfigService } from './config'

export type GroupSummaryTriggerType = 'auto' | 'manual'

export interface GroupSummaryTopic {
  title: string
  participants: string[]
  keyPoints: string[]
  conclusion: string
}

export interface GroupSummaryLog {
  endpoint: string
  model: string
  temperature: number
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  systemPrompt: string
  userPrompt: string
  rawOutput: string
  finalSummary: string
  durationMs: number
  createdAt: number
  responseFormatJson?: boolean
  responseFormatFallback?: boolean
  responseFormatFallbackReason?: string
  parsedTopics?: GroupSummaryTopic[]
}

export interface GroupSummaryRecord {
  id: string
  accountScope: string
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  topics: GroupSummaryTopic[]
  summaryText: string
  rawOutput: string
  log: GroupSummaryLog
}

export interface GroupSummaryRecordSummary {
  id: string
  createdAt: number
  sessionId: string
  displayName: string
  avatarUrl?: string
  triggerType: GroupSummaryTriggerType
  periodStart: number
  periodEnd: number
  messageCount: number
  readableMessageCount: number
  topics: GroupSummaryTopic[]
  summaryText: string
}

export interface GroupSummaryRecordFilters {
  sessionId?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

export interface GroupSummaryRecordListResult {
  success: boolean
  records: GroupSummaryRecordSummary[]
  total: number
  error?: string
}

class GroupSummaryRecordService {
  private readonly maxRecordsPerScope = 2000
  private filePath: string | null = null
  private loaded = false
  private records: GroupSummaryRecord[] = []

  private resolveFilePath(): string {
    if (this.filePath) return this.filePath
    const workerUserDataPath = String(process.env.WEFLOW_USER_DATA_PATH || process.env.WEFLOW_CONFIG_CWD || '').trim()
    const userDataPath = workerUserDataPath || app?.getPath?.('userData') || process.cwd()
    fs.mkdirSync(userDataPath, { recursive: true })
    this.filePath = path.join(userDataPath, 'weflow-group-summary-records.json')
    return this.filePath
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const filePath = this.resolveFilePath()
    try {
      if (!fs.existsSync(filePath)) return
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      const records = Array.isArray(parsed) ? parsed : parsed?.records
      if (Array.isArray(records)) {
        this.records = records.filter((item) => item && typeof item === 'object') as GroupSummaryRecord[]
      }
    } catch {
      this.records = []
    }
  }

  private persist(): void {
    try {
      const filePath = this.resolveFilePath()
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, records: this.records }, null, 2), 'utf-8')
    } catch {
      // Summary generation should not fail because local record persistence failed.
    }
  }

  private getCurrentAccountScope(): string {
    const config = ConfigService.getInstance()
    const myWxid = String(config.getMyWxidCleaned() || '').trim()
    if (myWxid) return `wxid:${myWxid}`

    const dbPath = String(config.get('dbPath') || '').trim()
    if (dbPath) {
      const hash = createHash('sha1').update(dbPath).digest('hex').slice(0, 16)
      return `db:${hash}`
    }
    return 'default'
  }

  private toSummary(record: GroupSummaryRecord): GroupSummaryRecordSummary {
    return {
      id: record.id,
      createdAt: record.createdAt,
      sessionId: record.sessionId,
      displayName: record.displayName,
      avatarUrl: record.avatarUrl,
      triggerType: record.triggerType,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
      messageCount: record.messageCount,
      readableMessageCount: record.readableMessageCount,
      topics: Array.isArray(record.topics) ? record.topics : [],
      summaryText: record.summaryText || ''
    }
  }

  private getScopedRecords(): GroupSummaryRecord[] {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    return this.records.filter((record) => record.accountScope === scope)
  }

  addRecord(input: {
    sessionId: string
    displayName: string
    avatarUrl?: string
    triggerType: GroupSummaryTriggerType
    periodStart: number
    periodEnd: number
    messageCount: number
    readableMessageCount: number
    topics: GroupSummaryTopic[]
    summaryText: string
    rawOutput: string
    log: GroupSummaryLog
  }): GroupSummaryRecord {
    this.ensureLoaded()
    const scope = this.getCurrentAccountScope()
    const record: GroupSummaryRecord = {
      id: randomUUID(),
      accountScope: scope,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      triggerType: input.triggerType,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      messageCount: input.messageCount,
      readableMessageCount: input.readableMessageCount,
      topics: input.topics,
      summaryText: input.summaryText,
      rawOutput: input.rawOutput,
      log: input.log
    }

    this.records.push(record)
    const scopedRecords = this.records
      .filter((item) => item.accountScope === scope)
      .sort((a, b) => b.createdAt - a.createdAt)
    const keepIds = new Set(scopedRecords.slice(0, this.maxRecordsPerScope).map((item) => item.id))
    this.records = this.records.filter((item) => item.accountScope !== scope || keepIds.has(item.id))
    this.persist()
    return record
  }

  hasAutoRecord(sessionId: string, periodStart: number, periodEnd: number): boolean {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) return false
    return this.getScopedRecords().some((record) =>
      record.triggerType === 'auto' &&
      record.sessionId === normalizedSessionId &&
      Number(record.periodStart || 0) === periodStart &&
      Number(record.periodEnd || 0) === periodEnd
    )
  }

  listRecords(filters: GroupSummaryRecordFilters = {}): GroupSummaryRecordListResult {
    try {
      const sessionId = String(filters.sessionId || '').trim()
      const startTime = Number(filters.startTime || 0)
      const endTime = Number(filters.endTime || 0)
      const offset = Math.max(0, Math.floor(Number(filters.offset || 0)))
      const limit = Math.min(200, Math.max(1, Math.floor(Number(filters.limit || 100))))

      const filtered = this.getScopedRecords()
        .filter((record) => {
          if (sessionId && record.sessionId !== sessionId) return false
          const periodStart = Number(record.periodStart || 0)
          const periodEnd = Number(record.periodEnd || 0)
          if (startTime > 0 && periodEnd < startTime) return false
          if (endTime > 0 && periodStart > endTime) return false
          return true
        })
        .sort((a, b) => Number(b.periodStart || b.createdAt) - Number(a.periodStart || a.createdAt))

      return {
        success: true,
        records: filtered.slice(offset, offset + limit).map((record) => this.toSummary(record)),
        total: filtered.length
      }
    } catch (error) {
      return { success: false, records: [], total: 0, error: (error as Error).message || String(error) }
    }
  }

  getRecord(id: string): { success: boolean; record?: GroupSummaryRecord; error?: string } {
    this.ensureLoaded()
    const normalizedId = String(id || '').trim()
    if (!normalizedId) return { success: false, error: '记录 ID 为空' }
    const scope = this.getCurrentAccountScope()
    const record = this.records.find((item) => item.id === normalizedId && item.accountScope === scope)
    if (!record) return { success: false, error: '未找到该群聊总结记录' }
    return { success: true, record }
  }

  clearRuntimeCache(): void {
    this.loaded = false
    this.records = []
    this.filePath = null
  }
}

export const groupSummaryRecordService = new GroupSummaryRecordService()
