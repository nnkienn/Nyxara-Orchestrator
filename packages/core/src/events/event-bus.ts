export type EventListener<Payload> = (payload: Payload) => void;

export class EventBus<EventMap extends object> {
  private readonly listeners = new Map<
    keyof EventMap,
    Set<EventListener<EventMap[keyof EventMap]>>
  >();

  on<EventName extends keyof EventMap>(
    eventName: EventName,
    listener: EventListener<EventMap[EventName]>,
  ): () => void {
    let eventListeners = this.listeners.get(eventName);

    if (!eventListeners) {
      eventListeners = new Set();
      this.listeners.set(eventName, eventListeners);
    }

    eventListeners.add(
      listener as EventListener<EventMap[keyof EventMap]>,
    );

    return () => {
      eventListeners.delete(
        listener as EventListener<EventMap[keyof EventMap]>,
      );
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

    for (const listener of eventListeners) {
      listener(payload);
    }
  }
}

