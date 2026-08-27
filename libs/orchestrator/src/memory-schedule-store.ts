import type { Schedule, ScheduleStore } from './schedule-store';

/** Reference implementation; also the test double. */
export class MemoryScheduleStore implements ScheduleStore {
  readonly #schedules = new Map<string, Schedule>();

  async readSchedule(scheduleId: string): Promise<Schedule | undefined> {
    return structuredClone(this.#schedules.get(scheduleId));
  }

  async writeSchedule(schedule: Schedule): Promise<void> {
    this.#schedules.set(schedule.scheduleId, structuredClone(schedule));
  }

  async listSchedules(limit?: number): Promise<Schedule[]> {
    const all = [...this.#schedules.values()].sort((a, b) =>
      b.scheduleId.localeCompare(a.scheduleId),
    );
    return structuredClone(all.slice(0, limit ?? 200));
  }

  async listEnabledSchedules(): Promise<Schedule[]> {
    return structuredClone(
      [...this.#schedules.values()].filter((s) => s.enabled),
    );
  }
}
