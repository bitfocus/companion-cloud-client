declare type EventCallback = (...args: any[]) => void;
export declare class EventEmitter {
    callbacks: Map<string, EventCallback[]>;
    on(event: string, callback: EventCallback): void;
    off(event: string, callback: EventCallback): void;
    removeAllListeners(event?: string): void;
    emit(event: string, ...args: any[]): void;
}
export {};
