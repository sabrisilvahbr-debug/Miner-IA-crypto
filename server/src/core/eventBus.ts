// Barramento de eventos interno. Persiste cada evento e notifica assinantes por padrão de tipo.
import { randomUUID } from 'node:crypto';
import type { DomainEvent, EventInput } from './types.ts';
import type { Store } from './store.ts';
import type { Logger } from './logger.ts';

export type EventListener = (e: DomainEvent) => void;

/** "metric.miner.*" casa com "metric.miner.hashrate"; "*" casa com tudo. */
export function matchesPattern(pattern: string, type: string): boolean {
  if (pattern === '*' || pattern === type) return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return false;
}

export class EventBus {
  private listeners = new Set<{ pattern: string; fn: EventListener }>();
  private store: Store;
  private logger: Logger;
  private now: () => number;
  private depth = 0;

  constructor(store: Store, logger: Logger, now: () => number = Date.now) {
    this.store = store;
    this.logger = logger;
    this.now = now;
  }

  publish(input: EventInput, persist = true): DomainEvent {
    const event: DomainEvent = { ...input, id: randomUUID(), ts: input.ts ?? this.now() };
    if (persist) {
      this.store.insertEvent(event);
      this.logger.log(event.severity, event.message, { event: event.type, agentId: event.agentId });
    }
    // Proteção contra cascatas infinitas de eventos.
    if (this.depth > 8) {
      this.logger.log('error', 'cascata de eventos interrompida', { type: event.type });
      return event;
    }
    this.depth++;
    try {
      for (const l of [...this.listeners]) {
        if (!matchesPattern(l.pattern, event.type)) continue;
        try {
          l.fn(event);
        } catch (e) {
          this.logger.log('error', 'falha em assinante de evento', { error: String(e), type: event.type });
        }
      }
    } finally {
      this.depth--;
    }
    return event;
  }

  subscribe(pattern: string, fn: EventListener): () => void {
    const entry = { pattern, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }
}
