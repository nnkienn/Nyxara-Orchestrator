export type EventListener<Payload> = (payload: Payload) => void;

export interface ListenerErrorReport {
  readonly eventName: string;
  readonly error: unknown;
}

export type ListenerErrorObserver = (report: ListenerErrorReport) => void;

/**
 * Metadata-only publish/subscribe bus. No payload history is retained, and a
 * throwing subscriber is isolated: Core execution must never fail because a
 * client (CLI, VS Code, tests) registered a faulty listener.
 */
export class EventBus<EventMap extends object> {
  private readonly listeners = new Map<
    keyof EventMap,
    Set<EventListener<EventMap[keyof EventMap]>>
  >();

  constructor(private readonly onListenerError?: ListenerErrorObserver) {}

  on<EventName extends keyof EventMap>(
    eventName: EventName,
    listener: EventListener<EventMap[EventName]>,
  ): () => void {
    let eventListeners = this.listeners.get(eventName);

    if (!eventListeners) {
      eventListeners = new Set();
      this.listeners.set(eventName, eventListeners);
    }

    const registered = listener as EventListener<EventMap[keyof EventMap]>;
    eventListeners.add(registered);

    return () => {
      eventListeners.delete(registered);
      if (eventListeners.size === 0) {
        this.listeners.delete(eventName);
      }
    };
  }

  emit<EventName extends keyof EventMap>(
    eventName: EventName,
    payload: EventMap[EventName],
  ): void {
    const eventListeners = this.listeners.get(eventName);

    if (!eventListeners) {
      return;
    }

    // Snapshot: a listener may subscribe or unsubscribe while handling.
    for (const listener of [...eventListeners]) {
      try {
        listener(payload);
      } catch (error: unknown) {
        this.reportListenerError(String(eventName), error);
      }
    }
  }

  listenerCount<EventName extends keyof EventMap>(eventName: EventName): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }

  private reportListenerError(eventName: string, error: unknown): void {
    if (!this.onListenerError) return;
    try {
      this.onListenerError({ eventName, error });
    } catch {
      // The error hook itself must not be able to break workflow execution.
    }
  }
}
