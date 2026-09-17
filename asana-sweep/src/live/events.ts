import { EventEmitter } from 'node:events';

export interface LiveEvent {
  kind: 'check' | 'run' | 'tick' | 'settings' | 'leads' | 'bd' | 'inbox' | 'monitor';
  account_id?: number;
  rule_id?: number;
}

/** In-process bus: anything that changes state emits here and the dashboard is told over SSE. */
class LiveEvents extends EventEmitter {
  emitUpdate(e: LiveEvent): void {
    this.emit('update', e);
  }
}

export const liveEvents = new LiveEvents();
liveEvents.setMaxListeners(200);
