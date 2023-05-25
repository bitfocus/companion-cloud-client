"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudClient = void 0;
const cloudconnection_1 = require("./cloudconnection");
const axios_1 = require("axios");
const events_1 = require("./events");
const generateRandomUUID = () => {
    let d = new Date().getTime();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = ((d + Math.random() * 16) % 16) | 0;
        d = Math.floor(d / 16);
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
};
const CLOUD_URL = process.env.NODE_ENV === 'production' ? 'https://api.bitfocus.io/v1' : 'https://api-staging.bitfocus.io/v1';
const COMPANION_PING_TIMEOUT = 5000;
class RegionFetchException extends Error {
    constructor(message) {
        super(message);
        this.name = 'RegionFetchException';
    }
}
/**
 * The CloudClient is responsible for connecting to the cloud and
 * communicating with the companion server
 */
class CloudClient extends events_1.EventEmitter {
    /**
     * Creates a new CloudClient
     *
     * @param remoteCompanionId The super secret id to connect to via the cloud
     */
    constructor(remoteCompanionId) {
        super();
        this.connections = [];
        this.currentRegions = [];
        this.regions = [];
        this.axios = axios_1.default.create({
            baseURL: CLOUD_URL,
            timeout: 10000,
        });
        this.counter = 0;
        this.moduleState = 'IDLE';
        this.updateIds = {};
        this.companionId = remoteCompanionId;
    }
    setState(state, message) {
        if (state !== this.moduleState) {
            this.moduleState = state;
            this.emit('state', state, message);
        }
    }
    calculateState() {
        const connected = this.connections.filter((c) => c.connectionState === 'CONNECTED').length;
        const connecting = this.connections.filter((c) => c.connectionState === 'CONNECTING').length;
        //const disconnected = this.connections.filter(c => c.connectionState === 'DISCONNECTED').length;
        const wants = this.regions.length;
        /*
         this code is commented because we want to know if we reach the remote companion, not if we are connected to all the regions
        if (connected >= wants) {
            this.setState('OK') // TODO: only if remote companion is also OK
        } else if (connected + connecting === 0) {
            this.setState('ERROR', 'Not connecting')
        } else if (connected === 0) {
            this.setState('ERROR', 'No connections established')
        } else if (connected < wants) {
            this.setState('WARNING', `Only ${connected} of ${wants} connections established`)
        }*/
        if (wants > 0 && connected === 0) {
            this.setState('ERROR', 'No relevant regions are reachable');
            this.emit('log', 'error', 'No relevant regions are reachable, check your internet connection');
        }
    }
    async updateRegionsFromREST() {
        const newRegions = await this.fetchRegionsFor(this.companionId);
        if (newRegions.length === 0) {
            this.emit('log', 'error', 'Remote companion does not seem to be registered with the cloud, retrying in 10 seconds');
            if (this.regions.length > 0) {
                this.regions = newRegions;
                this.recalculateRegions();
            }
            return;
        }
        this.regions = newRegions;
        this.recalculateRegions();
    }
    async recalculateRegions() {
        const regionsToRemove = this.currentRegions.filter((r) => !this.regions.find((nr) => nr.id === r.id));
        const regionsToAdd = this.regions.filter((r) => !this.currentRegions.find((nr) => nr.id === r.id));
        for (const region of regionsToRemove) {
            const connection = this.connections.find((c) => c.regionId === region.id);
            if (connection) {
                await connection.destroy();
                this.connections = this.connections.filter((c) => c.regionId !== region.id);
            }
            this.currentRegions = this.currentRegions.filter((r) => r.id !== region.id);
            this.emit('log', 'info', `Region ${region.label} removed`);
        }
        for (const region of regionsToAdd) {
            const newConnection = new cloudconnection_1.CloudConnection(region.id, region.hostname, this.companionId);
            this.connections = [...this.connections, newConnection];
            this.currentRegions = [...this.currentRegions, region];
            newConnection.on('socketstate', (state) => {
                //console.log('DEBUG; Region %o changed state to %o', region.id, state)
                this.calculateState();
            });
            newConnection.on('banks', (banks) => {
                if (this.updateIds[banks.updateId])
                    return;
                this.updateIds[banks.updateId] = Date.now();
                this.emit('updateAll', banks.data);
            });
            newConnection.on('bank', (bank) => {
                if (this.updateIds[bank.updateId])
                    return;
                this.emit('update', bank.page, bank.bank, bank.data);
                this.updateIds[bank.updateId] = Date.now();
            });
            newConnection.on('regions', (regions) => {
                //console.log('New regions: ', regions)
                //console.log('Old regions: ', this.regions)
            });
            void newConnection.init();
            this.emit('log', 'info', `Region ${region.label} added`);
        }
    }
    async fetchRegionsFor(companionId) {
        //if (this.counter++ < 2) return []
        try {
            return (await this.axios.get(`/infrastructure/cloud/regions/companion/${companionId}`)).data;
        }
        catch (e) {
            return [];
        }
    }
    /**
     * pinging is sent individually, and counted up, in contrast to clientCommand
     */
    async pingCompanion() {
        const onlineConnections = this.connections.filter((connection) => connection.connectionState === 'CONNECTED');
        const allThePromises = onlineConnections.map((connection) => {
            return new Promise((resolve, reject) => {
                const callerId = generateRandomUUID();
                const replyChannel = 'companionProcResult:' + callerId;
                const timeout = setTimeout(() => {
                    connection.socket?.unsubscribe(replyChannel);
                    connection.socket?.closeChannel(replyChannel);
                    reject(new Error('Timeout'));
                }, COMPANION_PING_TIMEOUT);
                (async () => {
                    for await (let data of connection.socket.subscribe(replyChannel)) {
                        //console.log('DEBUG: Got reply from companion', data)
                        connection.socket?.unsubscribe(replyChannel);
                        connection.socket?.closeChannel(replyChannel);
                        clearTimeout(timeout);
                        resolve(true);
                    }
                })();
                connection.socket?.transmitPublish?.(`companionProc:${this.companionId}:ping`, { args: [], callerId });
            });
        });
        const result = await Promise.allSettled(allThePromises);
        const success = result.filter((r) => r.status === 'fulfilled').length;
        const failed = result.filter((r) => r.status === 'rejected').length;
        if (success === 0 && this.regions.length > 0) {
            this.setState('ERROR', 'Remote companion is unreachable');
            this.emit('log', 'error', `Remote companion is unreachable via its ${this.regions.length} region connection${this.regions.length !== 1 ? 's' : ''}`);
        }
        else if (failed > 0) {
            this.setState('WARNING', `Remote companion is unreachable through some regions`);
            this.emit('log', 'warning', `Remote companion is only reachable on ${success} of ${onlineConnections.length} regions`);
        }
        else if (success === onlineConnections.length && onlineConnections.length > 0) {
            this.setState('OK');
        }
    }
    async clientCommand(name, ...args) {
        const callerId = generateRandomUUID();
        const replyChannel = 'companionProcResult:' + callerId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.connections
                    .filter((connection) => connection.connectionState === 'CONNECTED')
                    .forEach((connection) => {
                    connection.socket?.unsubscribe(replyChannel);
                    connection.socket?.closeChannel(replyChannel);
                });
                reject(new Error('ClientCommand timeout'));
            }, 10000);
            let isHandeled = false;
            this.connections
                .filter((connection) => connection.connectionState === 'CONNECTED')
                .forEach((connection) => {
                const socket = connection.socket;
                (async () => {
                    for await (let data of socket?.subscribe(replyChannel)) {
                        if (isHandeled) {
                            socket?.unsubscribe(replyChannel);
                            socket?.closeChannel(replyChannel);
                            return;
                        }
                        //							console.log('DEBUG; Got response for command %o', this.companionId + ':' + name)
                        clearTimeout(timer);
                        isHandeled = true;
                        if (data.error) {
                            reject(new Error('rpc error: ' + data.error));
                        }
                        else {
                            resolve(data.result);
                        }
                        socket?.unsubscribe(replyChannel);
                        socket?.closeChannel(replyChannel);
                        break;
                    }
                })();
                /*
                                    console.log(
                                        'DEBUG; Sending command to %o: %o',
                                        connection.regionId,
                                        `companionProc:${this.companionId}:${name}`
                                    )*/
                socket?.transmitPublish(`companionProc:${this.companionId}:${name}`, { args, callerId });
            });
        });
    }
    /**
     * Initializes the connection to the cloud
     */
    async init() {
        this.pingTimer = setInterval(() => {
            this.pingCompanion();
            // Cleanup update ids
            for (let key in this.updateIds) {
                if (Date.now() - this.updateIds[key] >= 30000) {
                    delete this.updateIds[key];
                }
            }
        }, COMPANION_PING_TIMEOUT + 2000);
        this.checkConnectionTimer = setInterval(() => {
            this.updateRegionsFromREST();
        }, 10000);
        await this.updateRegionsFromREST();
    }
    /**
     * Destroys running timers and connections
     */
    destroy() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }
        if (this.checkConnectionTimer) {
            clearInterval(this.checkConnectionTimer);
        }
        this.connections.forEach((connection) => {
            connection.destroy();
        });
        this.connections = [];
        this.regions = [];
    }
    connect() { }
}
exports.CloudClient = CloudClient;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290Ijoic3JjLyIsInNvdXJjZXMiOlsiaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsdURBQW1EO0FBQ25ELGlDQUF5QjtBQUV6QixxQ0FBdUM7QUFHdkMsTUFBTSxrQkFBa0IsR0FBRyxHQUFHLEVBQUU7SUFDL0IsSUFBSSxDQUFDLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQyxPQUFPLEVBQUUsQ0FBQTtJQUU1QixPQUFPLHNDQUFzQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsVUFBVSxDQUFDO1FBQ3pFLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLEVBQUUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQTtRQUM3QyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUE7UUFDdEIsT0FBTyxDQUFDLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFBO0lBQ3RELENBQUMsQ0FBQyxDQUFBO0FBQ0gsQ0FBQyxDQUFBO0FBRUQsTUFBTSxTQUFTLEdBQ2QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEtBQUssWUFBWSxDQUFDLENBQUMsQ0FBQyw0QkFBNEIsQ0FBQyxDQUFDLENBQUMsb0NBQW9DLENBQUE7QUFFNUcsTUFBTSxzQkFBc0IsR0FBRyxJQUFJLENBQUE7QUFTbkMsTUFBTSxvQkFBcUIsU0FBUSxLQUFLO0lBQ3ZDLFlBQVksT0FBZTtRQUMxQixLQUFLLENBQUMsT0FBTyxDQUFDLENBQUE7UUFDZCxJQUFJLENBQUMsSUFBSSxHQUFHLHNCQUFzQixDQUFBO0lBQ25DLENBQUM7Q0FDRDtBQWFEOzs7R0FHRztBQUNI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Q0FBQyxVQUFVLEVBQUUsRUFBRTtZQUN2QyxVQUFVLENBQUMsT0FBTyxFQUFFLENBQUE7UUFDckIsQ0FBQyxDQUFDLENBQUE7UUFDRixJQUFJLENBQUMsV0FBVyxHQUFHLEVBQUUsQ0FBQTtRQUNyQixJQUFJLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQTtJQUNsQixDQUFDO0lBRUQsT0FBTyxLQUFJLENBQUM7Q0FDWjtBQTNSRCxrQ0EyUkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBDbG91ZENvbm5lY3Rpb24gfSBmcm9tICcuL2Nsb3VkY29ubmVjdGlvbidcbmltcG9ydCBheGlvcyBmcm9tICdheGlvcydcbmltcG9ydCBTdHJpY3RFdmVudEVtaXR0ZXIgZnJvbSAnc3RyaWN0LWV2ZW50LWVtaXR0ZXItdHlwZXMnXG5pbXBvcnQgeyBFdmVudEVtaXR0ZXIgfSBmcm9tICcuL2V2ZW50cydcbmltcG9ydCB7IENvbXBhbmlvbkJ1dHRvblN0eWxlUHJvcHMsIE11bHRpQmFuayB9IGZyb20gJy4vdHlwZXMnXG5cbmNvbnN0IGdlbmVyYXRlUmFuZG9tVVVJRCA9ICgpID0+IHtcblx0bGV0IGQgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKVxuXG5cdHJldHVybiAneHh4eHh4eHgteHh4eC00eHh4LXl4eHgteHh4eHh4eHh4eHh4Jy5yZXBsYWNlKC9beHldL2csIGZ1bmN0aW9uIChjKSB7XG5cdFx0Y29uc3QgciA9ICgoZCArIE1hdGgucmFuZG9tKCkgKiAxNikgJSAxNikgfCAwXG5cdFx0ZCA9IE1hdGguZmxvb3IoZCAvIDE2KVxuXHRcdHJldHVybiAoYyA9PT0gJ3gnID8gciA6IChyICYgMHgzKSB8IDB4OCkudG9TdHJpbmcoMTYpXG5cdH0pXG59XG5cbmNvbnN0IENMT1VEX1VSTCA9XG5cdHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSAncHJvZHVjdGlvbicgPyAnaHR0cHM6Ly9hcGkuYml0Zm9jdXMuaW8vdjEnIDogJ2h0dHBzOi8vYXBpLXN0YWdpbmcuYml0Zm9jdXMuaW8vdjEnXG5cbmNvbnN0IENPTVBBTklPTl9QSU5HX1RJTUVPVVQgPSA1MDAwXG5cbmV4cG9ydCB0eXBlIFJlZ2lvbkRlZmluaXRpb24gPSB7XG5cdGlkOiBzdHJpbmdcblx0aG9zdG5hbWU6IHN0cmluZ1xuXHRsb2NhdGlvbjogc3RyaW5nXG5cdGxhYmVsOiBzdHJpbmdcbn1cblxuY2xhc3MgUmVnaW9uRmV0Y2hFeGNlcHRpb24gZXh0ZW5kcyBFcnJvciB7XG5cdGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuXHRcdHN1cGVyKG1lc3NhZ2UpXG5cdFx0dGhpcy5uYW1lID0gJ1JlZ2lvbkZldGNoRXhjZXB0aW9uJ1xuXHR9XG59XG5cbmV4cG9ydCB0eXBlIENDTW9kdWxlU3RhdGUgPSAnSURMRScgfCAnV0FSTklORycgfCAnRVJST1InIHwgJ09LJ1xuZXhwb3J0IHR5cGUgQ0NMb2dMZXZlbCA9ICdlcnJvcicgfCAnd2FybmluZycgfCAnaW5mbycgfCAnZGVidWcnXG5cbmludGVyZmFjZSBDbG91ZENsaWVudEV2ZW50cyB7XG5cdHN0YXRlOiAoc3RhdGU6IENDTW9kdWxlU3RhdGUsIG1lc3NhZ2U/OiBzdHJpbmcpID0+IHZvaWRcblx0ZXJyb3I6IChlcnJvcjogRXJyb3IpID0+IHZvaWRcblx0bG9nOiAobGV2ZWw6IENDTG9nTGV2ZWwsIG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZFxuXHR1cGRhdGU6IChwYWdlOiBudW1iZXIsIGJhbms6IG51bWJlciwgZGF0YTogQ29tcGFuaW9uQnV0dG9uU3R5bGVQcm9wcykgPT4gdm9pZFxuXHR1cGRhdGVBbGw6IChiYW5rczogeyBwYWdlOiBudW1iZXI7IGJhbms6IG51bWJlcjsgZGF0YTogQ29tcGFuaW9uQnV0dG9uU3R5bGVQcm9wcyB9W10pID0+IHZvaWRcbn1cblxuLyoqXG4gKiBUaGUgQ2xvdWRDbGllbnQgaXMgcmVzcG9uc2libGUgZm9yIGNvbm5lY3RpbmcgdG8gdGhlIGNsb3VkIGFuZFxuICogY29tbXVuaWNhdGluZyB3aXRoIHRoZSBjb21wYW5pb24gc2VydmVyXG4gKi9cbmV4cG9ydCBjbGFzcyBDbG91ZENsaWVudCBleHRlbmRzIChFdmVudEVtaXR0ZXIgYXMgeyBuZXcgKCk6IFN0cmljdEV2ZW50RW1pdHRlcjxFdmVudEVtaXR0ZXIsIENsb3VkQ2xpZW50RXZlbnRzPiB9KSB7XG5cdHByaXZhdGUgY29tcGFuaW9uSWQ6IHN0cmluZ1xuXHRwcml2YXRlIGNvbm5lY3Rpb25zOiBDbG91ZENvbm5lY3Rpb25bXSA9IFtdXG5cdHByaXZhdGUgY3VycmVudFJlZ2lvbnM6IFJlZ2lvbkRlZmluaXRpb25bXSA9IFtdXG5cdHByaXZhdGUgcmVnaW9uczogUmVnaW9uRGVmaW5pdGlvbltdID0gW11cblx0cHJpdmF0ZSBheGlvcyA9IGF4aW9zLmNyZWF0ZSh7XG5cdFx0YmFzZVVSTDogQ0xPVURfVVJMLFxuXHRcdHRpbWVvdXQ6IDEwMDAwLFxuXHR9KVxuXHRwcml2YXRlIGNvdW50ZXIgPSAwXG5cdHByaXZhdGUgbW9kdWxlU3RhdGU6IENDTW9kdWxlU3RhdGUgPSAnSURMRSdcblx0cHJpdmF0ZSBwaW5nVGltZXI6IE5vZGVKUy5UaW1lciB8IHVuZGVmaW5lZFxuXHRwcml2YXRlIGNoZWNrQ29ubmVjdGlvblRpbWVyOiBOb2RlSlMuVGltZXIgfCB1bmRlZmluZWRcblx0cHJpdmF0ZSB1cGRhdGVJZHM6IHsgW2tleTogc3RyaW5nXTogbnVtYmVyIH0gPSB7fVxuXG5cdC8qKlxuXHQgKiBDcmVhdGVzIGEgbmV3IENsb3VkQ2xpZW50XG5cdCAqXG5cdCAqIEBwYXJhbSByZW1vdGVDb21wYW5pb25JZCBUaGUgc3VwZXIgc2VjcmV0IGlkIHRvIGNvbm5lY3QgdG8gdmlhIHRoZSBjbG91ZFxuXHQgKi9cblx0Y29uc3RydWN0b3IocmVtb3RlQ29tcGFuaW9uSWQ6IHN0cmluZykge1xuXHRcdHN1cGVyKClcblx0XHR0aGlzLmNvbXBhbmlvbklkID0gcmVtb3RlQ29tcGFuaW9uSWRcblx0fVxuXG5cdHByaXZhdGUgc2V0U3RhdGUoc3RhdGU6IENDTW9kdWxlU3RhdGUsIG1lc3NhZ2U/OiBzdHJpbmcpIHtcblx0XHRpZiAoc3RhdGUgIT09IHRoaXMubW9kdWxlU3RhdGUpIHtcblx0XHRcdHRoaXMubW9kdWxlU3RhdGUgPSBzdGF0ZVxuXHRcdFx0dGhpcy5lbWl0KCdzdGF0ZScsIHN0YXRlLCBtZXNzYWdlKVxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgY2FsY3VsYXRlU3RhdGUoKSB7XG5cdFx0Y29uc3QgY29ubmVjdGVkID0gdGhpcy5jb25uZWN0aW9ucy5maWx0ZXIoKGMpID0+IGMuY29ubmVjdGlvblN0YXRlID09PSAnQ09OTkVDVEVEJykubGVuZ3RoXG5cdFx0Y29uc3QgY29ubmVjdGluZyA9IHRoaXMuY29ubmVjdGlvbnMuZmlsdGVyKChjKSA9PiBjLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ0NPTk5FQ1RJTkcnKS5sZW5ndGhcblx0XHQvL2NvbnN0IGRpc2Nvbm5lY3RlZCA9IHRoaXMuY29ubmVjdGlvbnMuZmlsdGVyKGMgPT4gYy5jb25uZWN0aW9uU3RhdGUgPT09ICdESVNDT05ORUNURUQnKS5sZW5ndGg7XG5cdFx0Y29uc3Qgd2FudHMgPSB0aGlzLnJlZ2lvbnMubGVuZ3RoXG5cblx0XHQvKlxuXHRcdCB0aGlzIGNvZGUgaXMgY29tbWVudGVkIGJlY2F1c2Ugd2Ugd2FudCB0byBrbm93IGlmIHdlIHJlYWNoIHRoZSByZW1vdGUgY29tcGFuaW9uLCBub3QgaWYgd2UgYXJlIGNvbm5lY3RlZCB0byBhbGwgdGhlIHJlZ2lvbnNcblx0XHRpZiAoY29ubmVjdGVkID49IHdhbnRzKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdPSycpIC8vIFRPRE86IG9ubHkgaWYgcmVtb3RlIGNvbXBhbmlvbiBpcyBhbHNvIE9LXG5cdFx0fSBlbHNlIGlmIChjb25uZWN0ZWQgKyBjb25uZWN0aW5nID09PSAwKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdFUlJPUicsICdOb3QgY29ubmVjdGluZycpXG5cdFx0fSBlbHNlIGlmIChjb25uZWN0ZWQgPT09IDApIHtcblx0XHRcdHRoaXMuc2V0U3RhdGUoJ0VSUk9SJywgJ05vIGNvbm5lY3Rpb25zIGVzdGFibGlzaGVkJylcblx0XHR9IGVsc2UgaWYgKGNvbm5lY3RlZCA8IHdhbnRzKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdXQVJOSU5HJywgYE9ubHkgJHtjb25uZWN0ZWR9IG9mICR7d2FudHN9IGNvbm5lY3Rpb25zIGVzdGFibGlzaGVkYClcblx0XHR9Ki9cblx0XHRpZiAod2FudHMgPiAwICYmIGNvbm5lY3RlZCA9PT0gMCkge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnRVJST1InLCAnTm8gcmVsZXZhbnQgcmVnaW9ucyBhcmUgcmVhY2hhYmxlJylcblx0XHRcdHRoaXMuZW1pdCgnbG9nJywgJ2Vycm9yJywgJ05vIHJlbGV2YW50IHJlZ2lvbnMgYXJlIHJlYWNoYWJsZSwgY2hlY2sgeW91ciBpbnRlcm5ldCBjb25uZWN0aW9uJylcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIHVwZGF0ZVJlZ2lvbnNGcm9tUkVTVCgpIHtcblx0XHRjb25zdCBuZXdSZWdpb25zID0gYXdhaXQgdGhpcy5mZXRjaFJlZ2lvbnNGb3IodGhpcy5jb21wYW5pb25JZClcblx0XHRpZiAobmV3UmVnaW9ucy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRoaXMuZW1pdChcblx0XHRcdFx0J2xvZycsXG5cdFx0XHRcdCdlcnJvcicsXG5cdFx0XHRcdCdSZW1vdGUgY29tcGFuaW9uIGRvZXMgbm90IHNlZW0gdG8gYmUgcmVnaXN0ZXJlZCB3aXRoIHRoZSBjbG91ZCwgcmV0cnlpbmcgaW4gMTAgc2Vjb25kcydcblx0XHRcdClcblx0XHRcdGlmICh0aGlzLnJlZ2lvbnMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHR0aGlzLnJlZ2lvbnMgPSBuZXdSZWdpb25zXG5cdFx0XHRcdHRoaXMucmVjYWxjdWxhdGVSZWdpb25zKClcdFx0XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm5cblx0XHR9XG5cdFx0dGhpcy5yZWdpb25zID0gbmV3UmVnaW9uc1xuXHRcdHRoaXMucmVjYWxjdWxhdGVSZWdpb25zKClcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgcmVjYWxjdWxhdGVSZWdpb25zKCkge1xuXHRcdGNvbnN0IHJlZ2lvbnNUb1JlbW92ZSA9IHRoaXMuY3VycmVudFJlZ2lvbnMuZmlsdGVyKChyKSA9PiAhdGhpcy5yZWdpb25zLmZpbmQoKG5yKSA9PiBuci5pZCA9PT0gci5pZCkpXG5cdFx0Y29uc3QgcmVnaW9uc1RvQWRkID0gdGhpcy5yZWdpb25zLmZpbHRlcigocikgPT4gIXRoaXMuY3VycmVudFJlZ2lvbnMuZmluZCgobnIpID0+IG5yLmlkID09PSByLmlkKSlcblxuXHRcdGZvciAoY29uc3QgcmVnaW9uIG9mIHJlZ2lvbnNUb1JlbW92ZSkge1xuXHRcdFx0Y29uc3QgY29ubmVjdGlvbiA9IHRoaXMuY29ubmVjdGlvbnMuZmluZCgoYykgPT4gYy5yZWdpb25JZCA9PT0gcmVnaW9uLmlkKVxuXHRcdFx0aWYgKGNvbm5lY3Rpb24pIHtcblx0XHRcdFx0YXdhaXQgY29ubmVjdGlvbi5kZXN0cm95KClcblx0XHRcdFx0dGhpcy5jb25uZWN0aW9ucyA9IHRoaXMuY29ubmVjdGlvbnMuZmlsdGVyKChjKSA9PiBjLnJlZ2lvbklkICE9PSByZWdpb24uaWQpXG5cdFx0XHR9XG5cdFx0XHR0aGlzLmN1cnJlbnRSZWdpb25zID0gdGhpcy5jdXJyZW50UmVnaW9ucy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IHJlZ2lvbi5pZClcblx0XHRcdHRoaXMuZW1pdCgnbG9nJywgJ2luZm8nLCBgUmVnaW9uICR7cmVnaW9uLmxhYmVsfSByZW1vdmVkYClcblx0XHR9XG5cblx0XHRmb3IgKGNvbnN0IHJlZ2lvbiBvZiByZWdpb25zVG9BZGQpIHtcblx0XHRcdGNvbnN0IG5ld0Nvbm5lY3Rpb24gPSBuZXcgQ2xvdWRDb25uZWN0aW9uKHJlZ2lvbi5pZCwgcmVnaW9uLmhvc3RuYW1lLCB0aGlzLmNvbXBhbmlvbklkKVxuXHRcdFx0dGhpcy5jb25uZWN0aW9ucyA9IFsuLi50aGlzLmNvbm5lY3Rpb25zLCBuZXdDb25uZWN0aW9uXVxuXHRcdFx0dGhpcy5jdXJyZW50UmVnaW9ucyA9IFsuLi50aGlzLmN1cnJlbnRSZWdpb25zLCByZWdpb25dXG5cblx0XHRcdG5ld0Nvbm5lY3Rpb24ub24oJ3NvY2tldHN0YXRlJywgKHN0YXRlKSA9PiB7XG5cdFx0XHRcdC8vY29uc29sZS5sb2coJ0RFQlVHOyBSZWdpb24gJW8gY2hhbmdlZCBzdGF0ZSB0byAlbycsIHJlZ2lvbi5pZCwgc3RhdGUpXG5cdFx0XHRcdHRoaXMuY2FsY3VsYXRlU3RhdGUoKVxuXHRcdFx0fSlcblxuXHRcdFx0bmV3Q29ubmVjdGlvbi5vbignYmFua3MnLCAoYmFua3MpID0+IHtcblx0XHRcdFx0aWYgKHRoaXMudXBkYXRlSWRzW2JhbmtzLnVwZGF0ZUlkXSkgcmV0dXJuXG5cdFx0XHRcdHRoaXMudXBkYXRlSWRzW2JhbmtzLnVwZGF0ZUlkXSA9IERhdGUubm93KClcblx0XHRcdFx0dGhpcy5lbWl0KCd1cGRhdGVBbGwnLCBiYW5rcy5kYXRhIGFzIE11bHRpQmFuaylcblx0XHRcdH0pXG5cblx0XHRcdG5ld0Nvbm5lY3Rpb24ub24oJ2JhbmsnLCAoYmFuaykgPT4ge1xuXHRcdFx0XHRpZiAodGhpcy51cGRhdGVJZHNbYmFuay51cGRhdGVJZF0pIHJldHVyblxuXHRcdFx0XHR0aGlzLmVtaXQoJ3VwZGF0ZScsIGJhbmsucGFnZSwgYmFuay5iYW5rLCBiYW5rLmRhdGEpXG5cdFx0XHRcdHRoaXMudXBkYXRlSWRzW2JhbmsudXBkYXRlSWRdID0gRGF0ZS5ub3coKVxuXHRcdFx0fSlcblxuXHRcdFx0bmV3Q29ubmVjdGlvbi5vbigncmVnaW9ucycsIChyZWdpb25zKSA9PiB7XG5cdFx0XHRcdC8vY29uc29sZS5sb2coJ05ldyByZWdpb25zOiAnLCByZWdpb25zKVxuXHRcdFx0XHQvL2NvbnNvbGUubG9nKCdPbGQgcmVnaW9uczogJywgdGhpcy5yZWdpb25zKVxuXHRcdFx0fSlcblxuXHRcdFx0dm9pZCBuZXdDb25uZWN0aW9uLmluaXQoKVxuXHRcdFx0dGhpcy5lbWl0KCdsb2cnLCAnaW5mbycsIGBSZWdpb24gJHtyZWdpb24ubGFiZWx9IGFkZGVkYClcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGZldGNoUmVnaW9uc0Zvcihjb21wYW5pb25JZDogc3RyaW5nKSB7XG5cdFx0Ly9pZiAodGhpcy5jb3VudGVyKysgPCAyKSByZXR1cm4gW11cblx0XHR0cnkge1xuXHRcdFx0cmV0dXJuIChhd2FpdCB0aGlzLmF4aW9zLmdldChgL2luZnJhc3RydWN0dXJlL2Nsb3VkL3JlZ2lvbnMvY29tcGFuaW9uLyR7Y29tcGFuaW9uSWR9YCkpLmRhdGEgYXMge1xuXHRcdFx0XHRpZDogc3RyaW5nXG5cdFx0XHRcdGhvc3RuYW1lOiBzdHJpbmdcblx0XHRcdFx0bG9jYXRpb246IHN0cmluZ1xuXHRcdFx0XHRsYWJlbDogc3RyaW5nXG5cdFx0XHR9W11cblx0XHR9IGNhdGNoIChlKSB7XG5cdFx0XHRyZXR1cm4gW11cblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogcGluZ2luZyBpcyBzZW50IGluZGl2aWR1YWxseSwgYW5kIGNvdW50ZWQgdXAsIGluIGNvbnRyYXN0IHRvIGNsaWVudENvbW1hbmRcblx0ICovXG5cdGFzeW5jIHBpbmdDb21wYW5pb24oKSB7XG5cdFx0Y29uc3Qgb25saW5lQ29ubmVjdGlvbnMgPSB0aGlzLmNvbm5lY3Rpb25zLmZpbHRlcigoY29ubmVjdGlvbikgPT4gY29ubmVjdGlvbi5jb25uZWN0aW9uU3RhdGUgPT09ICdDT05ORUNURUQnKVxuXG5cdFx0Y29uc3QgYWxsVGhlUHJvbWlzZXMgPSBvbmxpbmVDb25uZWN0aW9ucy5tYXAoKGNvbm5lY3Rpb24pID0+IHtcblx0XHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRcdGNvbnN0IGNhbGxlcklkID0gZ2VuZXJhdGVSYW5kb21VVUlEKClcblx0XHRcdFx0Y29uc3QgcmVwbHlDaGFubmVsID0gJ2NvbXBhbmlvblByb2NSZXN1bHQ6JyArIGNhbGxlcklkXG5cblx0XHRcdFx0Y29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdGNvbm5lY3Rpb24uc29ja2V0Py51bnN1YnNjcmliZShyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0Y29ubmVjdGlvbi5zb2NrZXQ/LmNsb3NlQ2hhbm5lbChyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcignVGltZW91dCcpKVxuXHRcdFx0XHR9LCBDT01QQU5JT05fUElOR19USU1FT1VUKVxuXG5cdFx0XHRcdDsoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdGZvciBhd2FpdCAobGV0IGRhdGEgb2YgY29ubmVjdGlvbi5zb2NrZXQuc3Vic2NyaWJlKHJlcGx5Q2hhbm5lbCkpIHtcblx0XHRcdFx0XHRcdC8vY29uc29sZS5sb2coJ0RFQlVHOiBHb3QgcmVwbHkgZnJvbSBjb21wYW5pb24nLCBkYXRhKVxuXHRcdFx0XHRcdFx0Y29ubmVjdGlvbi5zb2NrZXQ/LnVuc3Vic2NyaWJlKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHRcdGNvbm5lY3Rpb24uc29ja2V0Py5jbG9zZUNoYW5uZWwocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVvdXQpXG5cdFx0XHRcdFx0XHRyZXNvbHZlKHRydWUpXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9KSgpXG5cblx0XHRcdFx0Y29ubmVjdGlvbi5zb2NrZXQ/LnRyYW5zbWl0UHVibGlzaD8uKGBjb21wYW5pb25Qcm9jOiR7dGhpcy5jb21wYW5pb25JZH06cGluZ2AsIHsgYXJnczogW10sIGNhbGxlcklkIH0pXG5cdFx0XHR9KVxuXHRcdH0pXG5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQoYWxsVGhlUHJvbWlzZXMpXG5cdFx0Y29uc3Qgc3VjY2VzcyA9IHJlc3VsdC5maWx0ZXIoKHIpID0+IHIuc3RhdHVzID09PSAnZnVsZmlsbGVkJykubGVuZ3RoXG5cdFx0Y29uc3QgZmFpbGVkID0gcmVzdWx0LmZpbHRlcigocikgPT4gci5zdGF0dXMgPT09ICdyZWplY3RlZCcpLmxlbmd0aFxuXG5cdFx0aWYgKHN1Y2Nlc3MgPT09IDAgJiYgdGhpcy5yZWdpb25zLmxlbmd0aCA+IDApIHtcblx0XHRcdHRoaXMuc2V0U3RhdGUoJ0VSUk9SJywgJ1JlbW90ZSBjb21wYW5pb24gaXMgdW5yZWFjaGFibGUnKVxuXHRcdFx0dGhpcy5lbWl0KFxuXHRcdFx0XHQnbG9nJyxcblx0XHRcdFx0J2Vycm9yJyxcblx0XHRcdFx0YFJlbW90ZSBjb21wYW5pb24gaXMgdW5yZWFjaGFibGUgdmlhIGl0cyAke3RoaXMucmVnaW9ucy5sZW5ndGh9IHJlZ2lvbiBjb25uZWN0aW9uJHtcblx0XHRcdFx0XHR0aGlzLnJlZ2lvbnMubGVuZ3RoICE9PSAxID8gJ3MnIDogJydcblx0XHRcdFx0fWBcblx0XHRcdClcblx0XHR9IGVsc2UgaWYgKGZhaWxlZCA+IDApIHtcblx0XHRcdHRoaXMuc2V0U3RhdGUoJ1dBUk5JTkcnLCBgUmVtb3RlIGNvbXBhbmlvbiBpcyB1bnJlYWNoYWJsZSB0aHJvdWdoIHNvbWUgcmVnaW9uc2ApXG5cdFx0XHR0aGlzLmVtaXQoXG5cdFx0XHRcdCdsb2cnLFxuXHRcdFx0XHQnd2FybmluZycsXG5cdFx0XHRcdGBSZW1vdGUgY29tcGFuaW9uIGlzIG9ubHkgcmVhY2hhYmxlIG9uICR7c3VjY2Vzc30gb2YgJHtvbmxpbmVDb25uZWN0aW9ucy5sZW5ndGh9IHJlZ2lvbnNgXG5cdFx0XHQpXG5cdFx0fSBlbHNlIGlmIChzdWNjZXNzID09PSBvbmxpbmVDb25uZWN0aW9ucy5sZW5ndGggJiYgb25saW5lQ29ubmVjdGlvbnMubGVuZ3RoID4gMCkge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnT0snKVxuXHRcdH1cblx0fVxuXG5cdGFzeW5jIGNsaWVudENvbW1hbmQobmFtZTogc3RyaW5nLCAuLi5hcmdzOiBhbnlbXSkge1xuXHRcdGNvbnN0IGNhbGxlcklkID0gZ2VuZXJhdGVSYW5kb21VVUlEKClcblx0XHRjb25zdCByZXBseUNoYW5uZWwgPSAnY29tcGFuaW9uUHJvY1Jlc3VsdDonICsgY2FsbGVySWRcblxuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHR0aGlzLmNvbm5lY3Rpb25zXG5cdFx0XHRcdFx0LmZpbHRlcigoY29ubmVjdGlvbikgPT4gY29ubmVjdGlvbi5jb25uZWN0aW9uU3RhdGUgPT09ICdDT05ORUNURUQnKVxuXHRcdFx0XHRcdC5mb3JFYWNoKChjb25uZWN0aW9uKSA9PiB7XG5cdFx0XHRcdFx0XHRjb25uZWN0aW9uLnNvY2tldD8udW5zdWJzY3JpYmUocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdFx0Y29ubmVjdGlvbi5zb2NrZXQ/LmNsb3NlQ2hhbm5lbChyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0fSlcblx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcignQ2xpZW50Q29tbWFuZCB0aW1lb3V0JykpXG5cdFx0XHR9LCAxMDAwMClcblxuXHRcdFx0bGV0IGlzSGFuZGVsZWQgPSBmYWxzZVxuXHRcdFx0dGhpcy5jb25uZWN0aW9uc1xuXHRcdFx0XHQuZmlsdGVyKChjb25uZWN0aW9uKSA9PiBjb25uZWN0aW9uLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ0NPTk5FQ1RFRCcpXG5cdFx0XHRcdC5mb3JFYWNoKChjb25uZWN0aW9uKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3Qgc29ja2V0ID0gY29ubmVjdGlvbi5zb2NrZXRcblx0XHRcdFx0XHQ7KGFzeW5jICgpID0+IHtcblx0XHRcdFx0XHRcdGZvciBhd2FpdCAobGV0IGRhdGEgb2Ygc29ja2V0Py5zdWJzY3JpYmUocmVwbHlDaGFubmVsKSkge1xuXHRcdFx0XHRcdFx0XHRpZiAoaXNIYW5kZWxlZCkge1xuXHRcdFx0XHRcdFx0XHRcdHNvY2tldD8udW5zdWJzY3JpYmUocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdFx0XHRcdHNvY2tldD8uY2xvc2VDaGFubmVsKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm5cblx0XHRcdFx0XHRcdFx0fVxuXG4vL1x0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coJ0RFQlVHOyBHb3QgcmVzcG9uc2UgZm9yIGNvbW1hbmQgJW8nLCB0aGlzLmNvbXBhbmlvbklkICsgJzonICsgbmFtZSlcblx0XHRcdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVyKVxuXHRcdFx0XHRcdFx0XHRpc0hhbmRlbGVkID0gdHJ1ZVxuXG5cdFx0XHRcdFx0XHRcdGlmIChkYXRhLmVycm9yKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcigncnBjIGVycm9yOiAnICsgZGF0YS5lcnJvcikpXG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0cmVzb2x2ZShkYXRhLnJlc3VsdClcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdHNvY2tldD8udW5zdWJzY3JpYmUocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdFx0XHRzb2NrZXQ/LmNsb3NlQ2hhbm5lbChyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0XHRcdGJyZWFrXG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSkoKVxuLypcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhcblx0XHRcdFx0XHRcdCdERUJVRzsgU2VuZGluZyBjb21tYW5kIHRvICVvOiAlbycsXG5cdFx0XHRcdFx0XHRjb25uZWN0aW9uLnJlZ2lvbklkLFxuXHRcdFx0XHRcdFx0YGNvbXBhbmlvblByb2M6JHt0aGlzLmNvbXBhbmlvbklkfToke25hbWV9YFxuXHRcdFx0XHRcdCkqL1xuXHRcdFx0XHRcdHNvY2tldD8udHJhbnNtaXRQdWJsaXNoKGBjb21wYW5pb25Qcm9jOiR7dGhpcy5jb21wYW5pb25JZH06JHtuYW1lfWAsIHsgYXJncywgY2FsbGVySWQgfSlcblx0XHRcdFx0fSlcblx0XHR9KVxuXHR9XG5cblx0LyoqXG5cdCAqIEluaXRpYWxpemVzIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBjbG91ZFxuXHQgKi9cblx0YXN5bmMgaW5pdCgpIHtcblx0XHR0aGlzLnBpbmdUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcblx0XHRcdHRoaXMucGluZ0NvbXBhbmlvbigpXG5cblx0XHRcdC8vIENsZWFudXAgdXBkYXRlIGlkc1xuXHRcdFx0Zm9yIChsZXQga2V5IGluIHRoaXMudXBkYXRlSWRzKSB7XG5cdFx0XHRcdGlmIChEYXRlLm5vdygpIC0gdGhpcy51cGRhdGVJZHNba2V5XSA+PSAzMDAwMCkge1xuXHRcdFx0XHRcdGRlbGV0ZSB0aGlzLnVwZGF0ZUlkc1trZXldXG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9LCBDT01QQU5JT05fUElOR19USU1FT1VUICsgMjAwMClcblxuXHRcdHRoaXMuY2hlY2tDb25uZWN0aW9uVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG5cdFx0XHR0aGlzLnVwZGF0ZVJlZ2lvbnNGcm9tUkVTVCgpXG5cdFx0fSwgMTAwMDApO1xuXG5cdFx0YXdhaXQgdGhpcy51cGRhdGVSZWdpb25zRnJvbVJFU1QoKVxuXHR9XG5cblx0LyoqXG5cdCAqIERlc3Ryb3lzIHJ1bm5pbmcgdGltZXJzIGFuZCBjb25uZWN0aW9uc1xuXHQgKi9cblx0ZGVzdHJveSgpIHtcblx0XHRpZiAodGhpcy5waW5nVGltZXIpIHtcblx0XHRcdGNsZWFySW50ZXJ2YWwodGhpcy5waW5nVGltZXIpXG5cdFx0fVxuXHRcdGlmICh0aGlzLmNoZWNrQ29ubmVjdGlvblRpbWVyKSB7XG5cdFx0XHRjbGVhckludGVydmFsKHRoaXMuY2hlY2tDb25uZWN0aW9uVGltZXIpXG5cdFx0fVxuXHRcdHRoaXMuY29ubmVjdGlvbnMuZm9yRWFjaCgoY29ubmVjdGlvbikgPT4ge1xuXHRcdFx0Y29ubmVjdGlvbi5kZXN0cm95KClcblx0XHR9KVxuXHRcdHRoaXMuY29ubmVjdGlvbnMgPSBbXVxuXHRcdHRoaXMucmVnaW9ucyA9IFtdXG5cdH1cblxuXHRjb25uZWN0KCkge31cbn1cbiJdfQ==