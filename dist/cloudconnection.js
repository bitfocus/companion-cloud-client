"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudConnection = void 0;
const socketcluster_client_1 = require("socketcluster-client");
const events_1 = require("./events");
let str_LOCAL_CLOUD_PORT = process.env.LOCAL_CLOUD_PORT || process.env.REACT_LOCAL_CLOUD_PORT;
const LOCAL_CLOUD_PORT = str_LOCAL_CLOUD_PORT !== undefined ? parseInt(str_LOCAL_CLOUD_PORT) : 8000;
class CloudConnection extends events_1.EventEmitter {
    constructor(regionId, hostname, companionId) {
        super();
        this.connectionState = 'DISCONNECTED';
        this.regionId = regionId;
        this.hostname = hostname;
        this.companionId = companionId;
    }
    /**
     * Initializes the connection to the cloud
     */
    async init() {
        this.alive = true;
        this.socket = (0, socketcluster_client_1.create)({
            hostname: this.hostname,
            port: !this.hostname.match(/^(127\.|localhost)/) ? 443 : LOCAL_CLOUD_PORT,
            secure: !this.hostname.match(/^(127\.|localhost)/),
            autoReconnectOptions: {
                initialDelay: 1000,
                randomness: 2000,
                multiplier: 1.5,
                maxDelay: 10000, //milliseconds
            },
        });
        this.connectionState = 'CONNECTING';
        this.emit('socketstate', this.connectionState);
        this.socket.connect();
        this.initHandlers();
    }
    initHandlers() {
        ;
        (async () => {
            while (this.alive) {
                for await (const event of this.socket?.listener('connect') || []) {
                    this.connectionState = 'CONNECTED';
                    this.emit('socketstate', this.connectionState);
                }
            }
        })();
        (async () => {
            while (this.alive) {
                for await (const event of this.socket?.listener('disconnect') || []) {
                    this.connectionState = 'DISCONNECTED';
                    this.emit('socketstate', this.connectionState);
                }
            }
        })();
        (async () => {
            while (this.alive) {
                for await (const event of this.socket?.listener('error') || []) {
                    this.connectionState = 'DISCONNECTED';
                    this.emit('socketstate', this.connectionState);
                }
            }
        })();
        (async () => {
            while (this.alive) {
                for await (let data of this.socket?.subscribe('companion-banks:' + this.companionId)) {
                    if (data.type === 'single') {
                        this.emit('bank', data);
                    }
                    else if (data.type === 'all') {
                        this.emit('banks', data);
                    }
                }
            }
        })();
        (async () => {
            while (this.alive) {
                for await (let data of this.socket?.subscribe('companion-regions:' + this.companionId)) {
                    this.emit('regions', data);
                }
            }
        })();
    }
    /**
     * Destroys this object and disconnects from the cloud
     *
     * NB: Never use this object again after calling this method
     */
    async destroy() {
        // Stop event handler loops
        this.alive = false;
        // Kill it with fire
        this.socket.killAllChannels();
        this.socket.killAllListeners();
        this.socket.disconnect();
        this.removeAllListeners();
        // sorry, I don't want to have socket as a optional property
        // this.socket will only be undefined after it should be deleted/garbage collected
        let thes = this;
        delete thes.socket;
    }
}
exports.CloudConnection = CloudConnection;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRjb25uZWN0aW9uLmpzIiwic291cmNlUm9vdCI6InNyYy8iLCJzb3VyY2VzIjpbImNsb3VkY29ubmVjdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSwrREFBNkU7QUFFN0UscUNBQXVDO0FBSXZDLElBQUksb0JBQW9CLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLHNCQUFzQixDQUFBO0FBQzdGLE1BQU0sZ0JBQWdCLEdBQUcsb0JBQW9CLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFBO0FBZW5HLE1BQWEsZUFBZ0IsU0FBUyxxQkFFcEM7SUFTRCxZQUFZLFFBQWdCLEVBQUUsUUFBZ0IsRUFBRSxXQUFtQjtRQUNsRSxLQUFLLEVBQUUsQ0FBQTtRQUpELG9CQUFlLEdBQWlCLGNBQWMsQ0FBQTtRQUtwRCxJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQTtRQUN4QixJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQTtRQUN4QixJQUFJLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQTtJQUMvQixDQUFDO0lBRUQ7O09BRUc7SUFDSCxLQUFLLENBQUMsSUFBSTtRQUNULElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFBO1FBQ2pCLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBQSw2QkFBWSxFQUFDO1lBQzFCLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUTtZQUN2QixJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLGdCQUFnQjtZQUN6RSxNQUFNLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQztZQUNsRCxvQkFBb0IsRUFBRTtnQkFDckIsWUFBWSxFQUFFLElBQUk7Z0JBQ2xCLFVBQVUsRUFBRSxJQUFJO2dCQUNoQixVQUFVLEVBQUUsR0FBRztnQkFDZixRQUFRLEVBQUUsS0FBSyxFQUFFLGNBQWM7YUFDL0I7U0FDRCxDQUFDLENBQUE7UUFFRixJQUFJLENBQUMsZUFBZSxHQUFHLFlBQVksQ0FBQTtRQUNuQyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUE7UUFDOUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQTtRQUNyQixJQUFJLENBQUMsWUFBWSxFQUFFLENBQUE7SUFDcEIsQ0FBQztJQUVELFlBQVk7UUFDWCxDQUFDO1FBQUEsQ0FBQyxLQUFLLElBQUksRUFBRTtZQUNaLE9BQU8sSUFBSSxDQUFDLEtBQUssRUFBRTtnQkFDbEIsSUFBSSxLQUFLLEVBQUUsTUFBTSxLQUFLLElBQUksSUFBSSxDQUFDLE1BQU0sRUFBRSxRQUFRLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxFQUFFO29CQUNqRSxJQUFJLENBQUMsZUFBZSxHQUFHLFdBQVcsQ0FBQTtvQkFDbEMsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLEVBQUUsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFBO2lCQUM5QzthQUNEO1FBQ0YsQ0FBQyxDQUFDLEVBQUUsQ0FDSDtRQUFBLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDWixPQUFPLElBQUksQ0FBQyxLQUFLLEVBQUU7Z0JBQ2xCLElBQUksS0FBSyxFQUFFLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUUsUUFBUSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsRUFBRTtvQkFDcEUsSUFBSSxDQUFDLGVBQWUsR0FBRyxjQUFjLENBQUE7b0JBQ3JDLElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxFQUFFLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQTtpQkFDOUM7YUFDRDtRQUNGLENBQUMsQ0FBQyxFQUFFLENBQ0g7UUFBQSxDQUFDLEtBQUssSUFBSSxFQUFFO1lBQ1osT0FBTyxJQUFJLENBQUMsS0FBSyxFQUFFO2dCQUNsQixJQUFJLEtBQUssRUFBRSxNQUFNLEtBQUssSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEVBQUU7b0JBQy9ELElBQUksQ0FBQyxlQUFlLEdBQUcsY0FBYyxDQUFBO29CQUNyQyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUE7aUJBQzlDO2FBQ0Q7UUFDRixDQUFDLENBQUMsRUFBRSxDQUNIO1FBQUEsQ0FBQyxLQUFLLElBQUksRUFBRTtZQUNaLE9BQU8sSUFBSSxDQUFDLEtBQUssRUFBRTtnQkFDbEIsSUFBSSxLQUFLLEVBQUUsSUFBSSxJQUFJLElBQUksSUFBSSxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUMsa0JBQWtCLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxFQUFFO29CQUNyRixJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssUUFBUSxFQUFFO3dCQUMzQixJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUF5QyxDQUFDLENBQUE7cUJBQzVEO3lCQUFNLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxLQUFLLEVBQUU7d0JBQy9CLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUFFLElBQTZDLENBQUMsQ0FBQTtxQkFDakU7aUJBQ0Q7YUFDRDtRQUNGLENBQUMsQ0FBQyxFQUFFLENBQ0g7UUFBQSxDQUFDLEtBQUssSUFBSSxFQUFFO1lBQ1osT0FBTyxJQUFJLENBQUMsS0FBSyxFQUFFO2dCQUNsQixJQUFJLEtBQUssRUFBRSxJQUFJLElBQUksSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxvQkFBb0IsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLEVBQUU7b0JBQ3ZGLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQThDLENBQUMsQ0FBQTtpQkFDcEU7YUFDRDtRQUNGLENBQUMsQ0FBQyxFQUFFLENBQUE7SUFDTCxDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILEtBQUssQ0FBQyxPQUFPO1FBQ1osMkJBQTJCO1FBQzNCLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFBO1FBRWxCLG9CQUFvQjtRQUNwQixJQUFJLENBQUMsTUFBTSxDQUFDLGVBQWUsRUFBRSxDQUFBO1FBQzdCLElBQUksQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQTtRQUM5QixJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVUsRUFBRSxDQUFBO1FBRXhCLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFBO1FBRXpCLDREQUE0RDtRQUM1RCxrRkFBa0Y7UUFDbEYsSUFBSSxJQUFJLEdBQUcsSUFBVyxDQUFBO1FBQ3RCLE9BQU8sSUFBSSxDQUFDLE1BQU0sQ0FBQTtJQUNuQixDQUFDO0NBQ0Q7QUEzR0QsMENBMkdDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQUdDbGllbnRTb2NrZXQsIGNyZWF0ZSBhcyBjcmVhdGVTb2NrZXQgfSBmcm9tICdzb2NrZXRjbHVzdGVyLWNsaWVudCdcbmltcG9ydCBTdHJpY3RFdmVudEVtaXR0ZXIgZnJvbSAnc3RyaWN0LWV2ZW50LWVtaXR0ZXItdHlwZXMnXG5pbXBvcnQgeyBFdmVudEVtaXR0ZXIgfSBmcm9tICcuL2V2ZW50cydcbmltcG9ydCB7IFNpbmdsZUJhbmssIE11bHRpQmFuayB9IGZyb20gJy4vdHlwZXMnXG5leHBvcnQgdHlwZSBTb2NrZXRTdGF0ZXMgPSAnRElTQ09OTkVDVEVEJyB8ICdDT05ORUNUSU5HJyB8ICdDT05ORUNURUQnXG5cbmxldCBzdHJfTE9DQUxfQ0xPVURfUE9SVCA9IHByb2Nlc3MuZW52LkxPQ0FMX0NMT1VEX1BPUlQgfHwgcHJvY2Vzcy5lbnYuUkVBQ1RfTE9DQUxfQ0xPVURfUE9SVFxuY29uc3QgTE9DQUxfQ0xPVURfUE9SVCA9IHN0cl9MT0NBTF9DTE9VRF9QT1JUICE9PSB1bmRlZmluZWQgPyBwYXJzZUludChzdHJfTE9DQUxfQ0xPVURfUE9SVCkgOiA4MDAwXG5cbnR5cGUgUmVnaW9uRGV0YWlscyA9IHtcblx0aWQ6IHN0cmluZ1xuXHRob3N0OiBzdHJpbmdcbn1cblxuaW50ZXJmYWNlIENsb3VkQ29ubmVjdGlvbkV2ZW50cyB7XG5cdHNvY2tldHN0YXRlOiAoc3RhdGU6IFNvY2tldFN0YXRlcykgPT4gdm9pZFxuXHRlcnJvcjogKGVycm9yOiBFcnJvcikgPT4gdm9pZFxuXHRiYW5rOiAoYmFuazogU2luZ2xlQmFuayAmIHsgdXBkYXRlSWQ6IHN0cmluZyB9KSA9PiB2b2lkXG5cdGJhbmtzOiAoYmFua3M6IHsgdXBkYXRlSWQ6IHN0cmluZzsgZGF0YTogTXVsdGlCYW5rIH0pID0+IHZvaWRcblx0cmVnaW9uczogKHJlZ2lvbnM6IFJlZ2lvbkRldGFpbHNbXSkgPT4gdm9pZFxufVxuXG5leHBvcnQgY2xhc3MgQ2xvdWRDb25uZWN0aW9uIGV4dGVuZHMgKEV2ZW50RW1pdHRlciBhcyB7XG5cdG5ldyAoKTogU3RyaWN0RXZlbnRFbWl0dGVyPEV2ZW50RW1pdHRlciwgQ2xvdWRDb25uZWN0aW9uRXZlbnRzPlxufSkge1xuXHRwcml2YXRlIGNvbXBhbmlvbklkOiBzdHJpbmdcblx0cHJpdmF0ZSBob3N0bmFtZTogc3RyaW5nXG5cdHByaXZhdGUgYWxpdmU6IGJvb2xlYW5cblxuXHRwdWJsaWMgc29ja2V0OiBBR0NsaWVudFNvY2tldFxuXHRwdWJsaWMgY29ubmVjdGlvblN0YXRlOiBTb2NrZXRTdGF0ZXMgPSAnRElTQ09OTkVDVEVEJ1xuXHRwdWJsaWMgcmVnaW9uSWQ6IHN0cmluZ1xuXG5cdGNvbnN0cnVjdG9yKHJlZ2lvbklkOiBzdHJpbmcsIGhvc3RuYW1lOiBzdHJpbmcsIGNvbXBhbmlvbklkOiBzdHJpbmcpIHtcblx0XHRzdXBlcigpXG5cdFx0dGhpcy5yZWdpb25JZCA9IHJlZ2lvbklkXG5cdFx0dGhpcy5ob3N0bmFtZSA9IGhvc3RuYW1lXG5cdFx0dGhpcy5jb21wYW5pb25JZCA9IGNvbXBhbmlvbklkXG5cdH1cblxuXHQvKipcblx0ICogSW5pdGlhbGl6ZXMgdGhlIGNvbm5lY3Rpb24gdG8gdGhlIGNsb3VkXG5cdCAqL1xuXHRhc3luYyBpbml0KCkge1xuXHRcdHRoaXMuYWxpdmUgPSB0cnVlXG5cdFx0dGhpcy5zb2NrZXQgPSBjcmVhdGVTb2NrZXQoe1xuXHRcdFx0aG9zdG5hbWU6IHRoaXMuaG9zdG5hbWUsXG5cdFx0XHRwb3J0OiAhdGhpcy5ob3N0bmFtZS5tYXRjaCgvXigxMjdcXC58bG9jYWxob3N0KS8pID8gNDQzIDogTE9DQUxfQ0xPVURfUE9SVCxcblx0XHRcdHNlY3VyZTogIXRoaXMuaG9zdG5hbWUubWF0Y2goL14oMTI3XFwufGxvY2FsaG9zdCkvKSxcblx0XHRcdGF1dG9SZWNvbm5lY3RPcHRpb25zOiB7XG5cdFx0XHRcdGluaXRpYWxEZWxheTogMTAwMCwgLy9taWxsaXNlY29uZHNcblx0XHRcdFx0cmFuZG9tbmVzczogMjAwMCwgLy9taWxsaXNlY29uZHNcblx0XHRcdFx0bXVsdGlwbGllcjogMS41LCAvL2RlY2ltYWxcblx0XHRcdFx0bWF4RGVsYXk6IDEwMDAwLCAvL21pbGxpc2Vjb25kc1xuXHRcdFx0fSxcblx0XHR9KVxuXG5cdFx0dGhpcy5jb25uZWN0aW9uU3RhdGUgPSAnQ09OTkVDVElORydcblx0XHR0aGlzLmVtaXQoJ3NvY2tldHN0YXRlJywgdGhpcy5jb25uZWN0aW9uU3RhdGUpXG5cdFx0dGhpcy5zb2NrZXQuY29ubmVjdCgpXG5cdFx0dGhpcy5pbml0SGFuZGxlcnMoKVxuXHR9XG5cblx0aW5pdEhhbmRsZXJzKCkge1xuXHRcdDsoYXN5bmMgKCkgPT4ge1xuXHRcdFx0d2hpbGUgKHRoaXMuYWxpdmUpIHtcblx0XHRcdFx0Zm9yIGF3YWl0IChjb25zdCBldmVudCBvZiB0aGlzLnNvY2tldD8ubGlzdGVuZXIoJ2Nvbm5lY3QnKSB8fCBbXSkge1xuXHRcdFx0XHRcdHRoaXMuY29ubmVjdGlvblN0YXRlID0gJ0NPTk5FQ1RFRCdcblx0XHRcdFx0XHR0aGlzLmVtaXQoJ3NvY2tldHN0YXRlJywgdGhpcy5jb25uZWN0aW9uU3RhdGUpXG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9KSgpXG5cdFx0Oyhhc3luYyAoKSA9PiB7XG5cdFx0XHR3aGlsZSAodGhpcy5hbGl2ZSkge1xuXHRcdFx0XHRmb3IgYXdhaXQgKGNvbnN0IGV2ZW50IG9mIHRoaXMuc29ja2V0Py5saXN0ZW5lcignZGlzY29ubmVjdCcpIHx8IFtdKSB7XG5cdFx0XHRcdFx0dGhpcy5jb25uZWN0aW9uU3RhdGUgPSAnRElTQ09OTkVDVEVEJ1xuXHRcdFx0XHRcdHRoaXMuZW1pdCgnc29ja2V0c3RhdGUnLCB0aGlzLmNvbm5lY3Rpb25TdGF0ZSlcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0pKClcblx0XHQ7KGFzeW5jICgpID0+IHtcblx0XHRcdHdoaWxlICh0aGlzLmFsaXZlKSB7XG5cdFx0XHRcdGZvciBhd2FpdCAoY29uc3QgZXZlbnQgb2YgdGhpcy5zb2NrZXQ/Lmxpc3RlbmVyKCdlcnJvcicpIHx8IFtdKSB7XG5cdFx0XHRcdFx0dGhpcy5jb25uZWN0aW9uU3RhdGUgPSAnRElTQ09OTkVDVEVEJ1xuXHRcdFx0XHRcdHRoaXMuZW1pdCgnc29ja2V0c3RhdGUnLCB0aGlzLmNvbm5lY3Rpb25TdGF0ZSlcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0pKClcblx0XHQ7KGFzeW5jICgpID0+IHtcblx0XHRcdHdoaWxlICh0aGlzLmFsaXZlKSB7XG5cdFx0XHRcdGZvciBhd2FpdCAobGV0IGRhdGEgb2YgdGhpcy5zb2NrZXQ/LnN1YnNjcmliZSgnY29tcGFuaW9uLWJhbmtzOicgKyB0aGlzLmNvbXBhbmlvbklkKSkge1xuXHRcdFx0XHRcdGlmIChkYXRhLnR5cGUgPT09ICdzaW5nbGUnKSB7XG5cdFx0XHRcdFx0XHR0aGlzLmVtaXQoJ2JhbmsnLCBkYXRhIGFzIFNpbmdsZUJhbmsgJiB7IHVwZGF0ZUlkOiBzdHJpbmcgfSlcblx0XHRcdFx0XHR9IGVsc2UgaWYgKGRhdGEudHlwZSA9PT0gJ2FsbCcpIHtcblx0XHRcdFx0XHRcdHRoaXMuZW1pdCgnYmFua3MnLCBkYXRhIGFzIHsgdXBkYXRlSWQ6IHN0cmluZzsgZGF0YTogTXVsdGlCYW5rIH0pXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSkoKVxuXHRcdDsoYXN5bmMgKCkgPT4ge1xuXHRcdFx0d2hpbGUgKHRoaXMuYWxpdmUpIHtcblx0XHRcdFx0Zm9yIGF3YWl0IChsZXQgZGF0YSBvZiB0aGlzLnNvY2tldD8uc3Vic2NyaWJlKCdjb21wYW5pb24tcmVnaW9uczonICsgdGhpcy5jb21wYW5pb25JZCkpIHtcblx0XHRcdFx0XHR0aGlzLmVtaXQoJ3JlZ2lvbnMnLCBkYXRhIGFzIFJlZ2lvbkRldGFpbHNbXSAmIHsgdXBkYXRlSWQ6IHN0cmluZyB9KVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSkoKVxuXHR9XG5cblx0LyoqXG5cdCAqIERlc3Ryb3lzIHRoaXMgb2JqZWN0IGFuZCBkaXNjb25uZWN0cyBmcm9tIHRoZSBjbG91ZFxuXHQgKlxuXHQgKiBOQjogTmV2ZXIgdXNlIHRoaXMgb2JqZWN0IGFnYWluIGFmdGVyIGNhbGxpbmcgdGhpcyBtZXRob2Rcblx0ICovXG5cdGFzeW5jIGRlc3Ryb3koKSB7XG5cdFx0Ly8gU3RvcCBldmVudCBoYW5kbGVyIGxvb3BzXG5cdFx0dGhpcy5hbGl2ZSA9IGZhbHNlXG5cblx0XHQvLyBLaWxsIGl0IHdpdGggZmlyZVxuXHRcdHRoaXMuc29ja2V0LmtpbGxBbGxDaGFubmVscygpXG5cdFx0dGhpcy5zb2NrZXQua2lsbEFsbExpc3RlbmVycygpXG5cdFx0dGhpcy5zb2NrZXQuZGlzY29ubmVjdCgpXG5cblx0XHR0aGlzLnJlbW92ZUFsbExpc3RlbmVycygpXG5cblx0XHQvLyBzb3JyeSwgSSBkb24ndCB3YW50IHRvIGhhdmUgc29ja2V0IGFzIGEgb3B0aW9uYWwgcHJvcGVydHlcblx0XHQvLyB0aGlzLnNvY2tldCB3aWxsIG9ubHkgYmUgdW5kZWZpbmVkIGFmdGVyIGl0IHNob3VsZCBiZSBkZWxldGVkL2dhcmJhZ2UgY29sbGVjdGVkXG5cdFx0bGV0IHRoZXMgPSB0aGlzIGFzIGFueVxuXHRcdGRlbGV0ZSB0aGVzLnNvY2tldFxuXHR9XG59XG4iXX0=