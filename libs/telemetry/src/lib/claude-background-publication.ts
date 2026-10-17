import { asArray, asRecord, asString } from './unknown-value';

interface BackgroundPublication {
  toolUseId: string;
  command: string;
  startedAt: number;
  outputFile?: string;
  completedAt?: number;
  consumed: boolean;
}

/** Native Bash continuation evidence, scoped to one reducer session. Retain
 * tombstones so a repeated task/tool ID cannot authorize another result. */
export class ClaudeBackgroundPublications {
  private readonly tasks = new Map<string, BackgroundPublication>();

  constructor(private readonly sessionId: string) {}

  start(
    raw: Record<string, unknown>,
    toolUseId: string,
    command: string,
    assistantUuid: string | undefined,
  ): boolean {
    const result = asRecord(raw['toolUseResult']);
    if (result?.['backgroundTaskId'] === undefined) return false;
    const taskId = asString(result['backgroundTaskId']);
    const blocks = asArray(asRecord(raw['message'])?.['content']);
    const block = blocks?.length === 1 && asRecord(blocks[0]);
    const startedAt = Date.parse(asString(raw['timestamp']) ?? '');
    if (
      !taskId ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(taskId) ||
      command.length > 100_000 ||
      raw['type'] !== 'user' ||
      raw['isSidechain'] !== false ||
      !assistantUuid ||
      raw['sourceToolAssistantUUID'] !== assistantUuid ||
      result['interrupted'] !== false ||
      !block ||
      block['type'] !== 'tool_result' ||
      block['tool_use_id'] !== toolUseId ||
      block['is_error'] !== false ||
      !Number.isFinite(startedAt)
    )
      return true;
    const previous = [...this.tasks.values()].find(
      (task) => task.toolUseId === toolUseId,
    );
    if (previous || this.tasks.has(taskId)) {
      if (previous) previous.consumed = true;
      const duplicate = this.tasks.get(taskId);
      if (duplicate) duplicate.consumed = true;
      return true;
    }
    // Overflow is unknown, never an eviction that permits ID reuse.
    if (this.tasks.size < 64)
      this.tasks.set(taskId, {
        toolUseId,
        command,
        startedAt,
        consumed: false,
      });
    return true;
  }

  observe(raw: Record<string, unknown>): void {
    const origin = asRecord(raw['origin']);
    const message = asRecord(raw['message']);
    if (
      raw['type'] !== 'user' ||
      raw['isSidechain'] !== false ||
      raw['promptSource'] !== 'system' ||
      raw['turnOrigin'] !== 'task_notification' ||
      origin?.['kind'] !== 'task-notification' ||
      origin['producer'] !== 'session-task' ||
      !asString(origin['runId']) ||
      message?.['role'] !== 'user'
    )
      return;
    const content = asString(message['content']);
    if (!content || content.length > 16_384) return;
    const fields =
      /^<task-notification>\n<task-id>([A-Za-z0-9_-]{1,128})<\/task-id>\n<tool-use-id>([A-Za-z0-9_-]{1,128})<\/tool-use-id>\n<output-file>([^\n<>]{1,4096})<\/output-file>\n<status>([a-z]+)<\/status>\n<summary>[^\n<>]{1,2048} \(exit code (-?[0-9]{1,3})\)<\/summary>\n<\/task-notification>$/u.exec(
        content,
      );
    if (!fields) return;
    const [, taskId, toolUseId, outputFile, status, exit] = fields;
    const task = this.tasks.get(taskId);
    if (!task || task.consumed) return;
    const completedAt = Date.parse(asString(raw['timestamp']) ?? '');
    if (
      task.toolUseId !== toolUseId ||
      status !== 'completed' ||
      exit !== '0' ||
      !Number.isFinite(completedAt) ||
      completedAt < task.startedAt ||
      !/^\/tmp\/claude-[0-9]+\/[A-Za-z0-9_./-]+$/u.test(outputFile) ||
      outputFile
        .split('/')
        .some((segment) => segment === '.' || segment === '..') ||
      !outputFile.endsWith(`/${this.sessionId}/tasks/${taskId}.output`) ||
      (task.outputFile !== undefined && task.outputFile !== outputFile)
    ) {
      task.consumed = true;
      return;
    }
    task.outputFile = outputFile;
    task.completedAt ??= completedAt;
  }

  finish(
    raw: Record<string, unknown>,
    command: string,
    result: Record<string, unknown>,
    assistantUuid: string | undefined,
  ): { command: string; output: string } | undefined {
    // Only one literal read of the provider-bound completed output. This is
    // deliberately not a shell parser and never reads the filesystem itself.
    const read =
      /^(?:tail (?:-[1-9][0-9]{0,2}|-n [1-9][0-9]{0,2})|cat) (\/[A-Za-z0-9_./-]+)$/u.exec(
        command.trim(),
      );
    if (
      !read ||
      raw['type'] !== 'user' ||
      raw['isSidechain'] !== false ||
      !assistantUuid ||
      raw['sourceToolAssistantUUID'] !== assistantUuid
    )
      return undefined;
    const task = [...this.tasks.values()].find(
      (value) => !value.consumed && value.outputFile === read[1],
    );
    if (!task) return undefined;
    task.consumed = true;
    const native = asRecord(raw['toolUseResult']);
    const blocks = asArray(asRecord(raw['message'])?.['content']);
    const output = asString(native?.['stdout']);
    const at = Date.parse(asString(raw['timestamp']) ?? '');
    if (
      result['is_error'] !== false ||
      blocks?.length !== 1 ||
      blocks[0] !== result ||
      native?.['interrupted'] !== false ||
      native['backgroundTaskId'] !== undefined ||
      output === undefined ||
      output.length > 100_000 ||
      result['content'] !== output ||
      !Number.isFinite(at) ||
      task.completedAt === undefined ||
      at < task.completedAt
    )
      return undefined;
    return { command: task.command, output };
  }
}
