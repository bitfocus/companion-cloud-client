type EventCallback = (...args: any[]) => void

// After a lot of arguing with "vite" and react-native with the
// built-in EventEmitter, I decided to just write my own simple one.
export class EventEmitter {
	callbacks = new Map<string, EventCallback[]>()

	on(event: string, callback: EventCallback) {
		let callbacks = this.callbacks.get(event)
		if (!callbacks) {
			this.callbacks.set(event, (callbacks = []))
		}

		callbacks.push(callback)
	}

	off(event: string, callback: EventCallback) {
		const callbacks = this.callbacks.get(event)
		if (!callbacks) return

		const index = callbacks.indexOf(callback)
		if (index === -1) return

		callbacks.splice(index, 1)
	}

	removeAllListeners(event?: string) {
        if (event === undefined) {
            this.callbacks.clear()
            return
        }

        this.callbacks.delete(event)
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	emit(event: string, ...args: any[]) {
		const callbacks = this.callbacks.get(event)
		if (!callbacks) return

		for (const callback of callbacks) {
			callback(...args)
		}
	}
}