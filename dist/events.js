"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventEmitter = void 0;
// After a lot of arguing with "vite" and react-native with the
// built-in EventEmitter, I decided to just write my own simple one.
class EventEmitter {
    constructor() {
        this.callbacks = new Map();
    }
    on(event, callback) {
        let callbacks = this.callbacks.get(event);
        if (!callbacks) {
            this.callbacks.set(event, (callbacks = []));
        }
        callbacks.push(callback);
    }
    off(event, callback) {
        const callbacks = this.callbacks.get(event);
        if (!callbacks)
            return;
        const index = callbacks.indexOf(callback);
        if (index === -1)
            return;
        callbacks.splice(index, 1);
    }
    removeAllListeners(event) {
        if (event === undefined) {
            this.callbacks.clear();
            return;
        }
        this.callbacks.delete(event);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit(event, ...args) {
        const callbacks = this.callbacks.get(event);
        if (!callbacks)
            return;
        for (const callback of callbacks) {
            callback(...args);
        }
    }
}
exports.EventEmitter = EventEmitter;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnRzLmpzIiwic291cmNlUm9vdCI6InNyYy8iLCJzb3VyY2VzIjpbImV2ZW50cy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFFQSwrREFBK0Q7QUFDL0Qsb0VBQW9FO0FBQ3BFLE1BQWEsWUFBWTtJQUF6QjtRQUNDLGNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBMkIsQ0FBQTtJQXVDL0MsQ0FBQztJQXJDQSxFQUFFLENBQUMsS0FBYSxFQUFFLFFBQXVCO1FBQ3hDLElBQUksU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFBO1FBQ3pDLElBQUksQ0FBQyxTQUFTLEVBQUU7WUFDZixJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxTQUFTLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQTtTQUMzQztRQUVELFNBQVMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUE7SUFDekIsQ0FBQztJQUVELEdBQUcsQ0FBQyxLQUFhLEVBQUUsUUFBdUI7UUFDekMsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUE7UUFDM0MsSUFBSSxDQUFDLFNBQVM7WUFBRSxPQUFNO1FBRXRCLE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUE7UUFDekMsSUFBSSxLQUFLLEtBQUssQ0FBQyxDQUFDO1lBQUUsT0FBTTtRQUV4QixTQUFTLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQTtJQUMzQixDQUFDO0lBRUQsa0JBQWtCLENBQUMsS0FBYztRQUMxQixJQUFJLEtBQUssS0FBSyxTQUFTLEVBQUU7WUFDckIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLEVBQUUsQ0FBQTtZQUN0QixPQUFNO1NBQ1Q7UUFFRCxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQTtJQUNuQyxDQUFDO0lBRUQsOERBQThEO0lBQzlELElBQUksQ0FBQyxLQUFhLEVBQUUsR0FBRyxJQUFXO1FBQ2pDLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFBO1FBQzNDLElBQUksQ0FBQyxTQUFTO1lBQUUsT0FBTTtRQUV0QixLQUFLLE1BQU0sUUFBUSxJQUFJLFNBQVMsRUFBRTtZQUNqQyxRQUFRLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQTtTQUNqQjtJQUNGLENBQUM7Q0FDRDtBQXhDRCxvQ0F3Q0MiLCJzb3VyY2VzQ29udGVudCI6WyJ0eXBlIEV2ZW50Q2FsbGJhY2sgPSAoLi4uYXJnczogYW55W10pID0+IHZvaWRcblxuLy8gQWZ0ZXIgYSBsb3Qgb2YgYXJndWluZyB3aXRoIFwidml0ZVwiIGFuZCByZWFjdC1uYXRpdmUgd2l0aCB0aGVcbi8vIGJ1aWx0LWluIEV2ZW50RW1pdHRlciwgSSBkZWNpZGVkIHRvIGp1c3Qgd3JpdGUgbXkgb3duIHNpbXBsZSBvbmUuXG5leHBvcnQgY2xhc3MgRXZlbnRFbWl0dGVyIHtcblx0Y2FsbGJhY2tzID0gbmV3IE1hcDxzdHJpbmcsIEV2ZW50Q2FsbGJhY2tbXT4oKVxuXG5cdG9uKGV2ZW50OiBzdHJpbmcsIGNhbGxiYWNrOiBFdmVudENhbGxiYWNrKSB7XG5cdFx0bGV0IGNhbGxiYWNrcyA9IHRoaXMuY2FsbGJhY2tzLmdldChldmVudClcblx0XHRpZiAoIWNhbGxiYWNrcykge1xuXHRcdFx0dGhpcy5jYWxsYmFja3Muc2V0KGV2ZW50LCAoY2FsbGJhY2tzID0gW10pKVxuXHRcdH1cblxuXHRcdGNhbGxiYWNrcy5wdXNoKGNhbGxiYWNrKVxuXHR9XG5cblx0b2ZmKGV2ZW50OiBzdHJpbmcsIGNhbGxiYWNrOiBFdmVudENhbGxiYWNrKSB7XG5cdFx0Y29uc3QgY2FsbGJhY2tzID0gdGhpcy5jYWxsYmFja3MuZ2V0KGV2ZW50KVxuXHRcdGlmICghY2FsbGJhY2tzKSByZXR1cm5cblxuXHRcdGNvbnN0IGluZGV4ID0gY2FsbGJhY2tzLmluZGV4T2YoY2FsbGJhY2spXG5cdFx0aWYgKGluZGV4ID09PSAtMSkgcmV0dXJuXG5cblx0XHRjYWxsYmFja3Muc3BsaWNlKGluZGV4LCAxKVxuXHR9XG5cblx0cmVtb3ZlQWxsTGlzdGVuZXJzKGV2ZW50Pzogc3RyaW5nKSB7XG4gICAgICAgIGlmIChldmVudCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0aGlzLmNhbGxiYWNrcy5jbGVhcigpXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY2FsbGJhY2tzLmRlbGV0ZShldmVudClcblx0fVxuXG5cdC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55XG5cdGVtaXQoZXZlbnQ6IHN0cmluZywgLi4uYXJnczogYW55W10pIHtcblx0XHRjb25zdCBjYWxsYmFja3MgPSB0aGlzLmNhbGxiYWNrcy5nZXQoZXZlbnQpXG5cdFx0aWYgKCFjYWxsYmFja3MpIHJldHVyblxuXG5cdFx0Zm9yIChjb25zdCBjYWxsYmFjayBvZiBjYWxsYmFja3MpIHtcblx0XHRcdGNhbGxiYWNrKC4uLmFyZ3MpXG5cdFx0fVxuXHR9XG59Il19