"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudClient = void 0;
const cloudconnection_1 = require("./cloudconnection");
const axios_1 = require("axios");
const events_1 = require("./events");
// We don't use external modules for this or eventemitter, so that this module
// can be used more easily for node/web/electron/react-native projects.
const generateRandomUUID = () => {
    let d = new Date().getTime();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (d + Math.random() * 16) % 16 | 0;
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
        this.protocolVersion = 1;
        this.connections = [];
        this.currentRegions = [];
        this.regions = [];
        this.axios = axios_1.default.create({
            baseURL: CLOUD_URL,
            timeout: 10000,
        });
        this.counter = 0;
        this.connectingCounter = 0;
        this.moduleState = 'IDLE';
        this.checkingRegions = false;
        this.updateIds = {};
        this.companionId = remoteCompanionId;
    }
    setState(state, message) {
        if (state !== this.moduleState) {
            this.moduleState = state;
            this.emit('state', state, message);
            this.connectingCounter = 0;
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
        if (!this.checkingRegions && wants > 0 && connected === 0) {
            if (this.connectingCounter++ > 3) {
                //console.log(this.checkingRegions, wants, connected)
                this.setState('ERROR', 'No relevant regions are reachable');
                this.emit('log', 'error', 'No relevant regions are reachable, check your internet connection');
                this.connectingCounter = 0;
            }
        }
        // Make sure we test the connections immediately after we have connected to all regions
        // to get a fast main state update
        if (connected == wants) {
            this.pingCompanion();
        }
    }
    async updateRegionsFromREST() {
        this.checkingRegions = true;
        const newRegions = await this.fetchRegionsFor(this.companionId);
        this.checkingRegions = false;
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
                // In protocol v1+ we have location property
                banks.data = banks.data.map((bank) => ({
                    ...bank,
                    location: bank.p >= 1 ? bank.location : { pageNumber: bank.page ?? 0, row: bank.bank ?? 0, column: 0 },
                }));
                this.emit('updateAll', banks.data);
            });
            newConnection.on('bank', (bank) => {
                if (this.updateIds[bank.updateId])
                    return;
                if (!bank.p) {
                    bank.location = {
                        pageNumber: bank.page ?? 0,
                        row: bank.bank ?? 0,
                        column: 0,
                    };
                }
                this.emit('update', bank.location, bank.data);
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
        this.setState('WARNING', 'Connecting to cloud');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290Ijoic3JjLyIsInNvdXJjZXMiOlsiaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsdURBQW1EO0FBQ25ELGlDQUF5QjtBQUV6QixxQ0FBdUM7QUFHdkMsOEVBQThFO0FBQzlFLHVFQUF1RTtBQUN2RSxNQUFNLGtCQUFrQixHQUFHLEdBQUcsRUFBRTtJQUMvQixJQUFJLENBQUMsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRSxDQUFBO0lBRTVCLE9BQU8sc0NBQXNDLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxVQUFVLENBQUM7UUFDekUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxHQUFHLEVBQUUsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUE7UUFDM0MsQ0FBQyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFBO1FBQ3RCLE9BQU8sQ0FBQyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQTtJQUN0RCxDQUFDLENBQUMsQ0FBQTtBQUNILENBQUMsQ0FBQTtBQUVELE1BQU0sU0FBUyxHQUNkLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxLQUFLLFlBQVksQ0FBQyxDQUFDLENBQUMsNEJBQTRCLENBQUMsQ0FBQyxDQUFDLG9DQUFvQyxDQUFBO0FBRTVHLE1BQU0sc0JBQXNCLEdBQUcsSUFBSSxDQUFBO0FBU25DLE1BQU0sb0JBQXFCLFNBQVEsS0FBSztJQUN2QyxZQUFZLE9BQWU7UUFDMUIsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFBO1FBQ2QsSUFBSSxDQUFDLElBQUksR0FBRyxzQkFBc0IsQ0FBQTtJQUNuQyxDQUFDO0NBQ0Q7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QzlCLGFBQWEsQ0FBQyxJQUFJLENBQUMsb0JBQW9CLENBQUMsQ0FBQTtTQUN4QztRQUNELElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUMsVUFBVSxFQUFFLEVBQUU7WUFDdkMsVUFBVSxDQUFDLE9BQU8sRUFBRSxDQUFBO1FBQ3JCLENBQUMsQ0FBQyxDQUFBO1FBQ0YsSUFBSSxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUE7UUFDckIsSUFBSSxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUE7SUFDbEIsQ0FBQztJQUVELE9BQU8sS0FBSSxDQUFDO0NBQ1o7QUExVEQsa0NBMFRDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ2xvdWRDb25uZWN0aW9uIH0gZnJvbSAnLi9jbG91ZGNvbm5lY3Rpb24nXG5pbXBvcnQgYXhpb3MgZnJvbSAnYXhpb3MnXG5pbXBvcnQgU3RyaWN0RXZlbnRFbWl0dGVyIGZyb20gJ3N0cmljdC1ldmVudC1lbWl0dGVyLXR5cGVzJ1xuaW1wb3J0IHsgRXZlbnRFbWl0dGVyIH0gZnJvbSAnLi9ldmVudHMnXG5pbXBvcnQgeyBDb21wYW5pb25CdXR0b25TdHlsZVByb3BzLCBDb250cm9sTG9jYXRpb24sIE11bHRpQmFuayB9IGZyb20gJy4vdHlwZXMnXG5cbi8vIFdlIGRvbid0IHVzZSBleHRlcm5hbCBtb2R1bGVzIGZvciB0aGlzIG9yIGV2ZW50ZW1pdHRlciwgc28gdGhhdCB0aGlzIG1vZHVsZVxuLy8gY2FuIGJlIHVzZWQgbW9yZSBlYXNpbHkgZm9yIG5vZGUvd2ViL2VsZWN0cm9uL3JlYWN0LW5hdGl2ZSBwcm9qZWN0cy5cbmNvbnN0IGdlbmVyYXRlUmFuZG9tVVVJRCA9ICgpID0+IHtcblx0bGV0IGQgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKVxuXG5cdHJldHVybiAneHh4eHh4eHgteHh4eC00eHh4LXl4eHgteHh4eHh4eHh4eHh4Jy5yZXBsYWNlKC9beHldL2csIGZ1bmN0aW9uIChjKSB7XG5cdFx0Y29uc3QgciA9IChkICsgTWF0aC5yYW5kb20oKSAqIDE2KSAlIDE2IHwgMFxuXHRcdGQgPSBNYXRoLmZsb29yKGQgLyAxNilcblx0XHRyZXR1cm4gKGMgPT09ICd4JyA/IHIgOiAociAmIDB4MykgfCAweDgpLnRvU3RyaW5nKDE2KVxuXHR9KVxufVxuXG5jb25zdCBDTE9VRF9VUkwgPVxuXHRwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gJ3Byb2R1Y3Rpb24nID8gJ2h0dHBzOi8vYXBpLmJpdGZvY3VzLmlvL3YxJyA6ICdodHRwczovL2FwaS1zdGFnaW5nLmJpdGZvY3VzLmlvL3YxJ1xuXG5jb25zdCBDT01QQU5JT05fUElOR19USU1FT1VUID0gNTAwMFxuXG5leHBvcnQgdHlwZSBSZWdpb25EZWZpbml0aW9uID0ge1xuXHRpZDogc3RyaW5nXG5cdGhvc3RuYW1lOiBzdHJpbmdcblx0bG9jYXRpb246IHN0cmluZ1xuXHRsYWJlbDogc3RyaW5nXG59XG5cbmNsYXNzIFJlZ2lvbkZldGNoRXhjZXB0aW9uIGV4dGVuZHMgRXJyb3Ige1xuXHRjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcblx0XHRzdXBlcihtZXNzYWdlKVxuXHRcdHRoaXMubmFtZSA9ICdSZWdpb25GZXRjaEV4Y2VwdGlvbidcblx0fVxufVxuXG5leHBvcnQgdHlwZSBDQ01vZHVsZVN0YXRlID0gJ0lETEUnIHwgJ1dBUk5JTkcnIHwgJ0VSUk9SJyB8ICdPSydcbmV4cG9ydCB0eXBlIENDTG9nTGV2ZWwgPSAnZXJyb3InIHwgJ3dhcm5pbmcnIHwgJ2luZm8nIHwgJ2RlYnVnJ1xuXG5pbnRlcmZhY2UgQ2xvdWRDbGllbnRFdmVudHMge1xuXHRzdGF0ZTogKHN0YXRlOiBDQ01vZHVsZVN0YXRlLCBtZXNzYWdlPzogc3RyaW5nKSA9PiB2b2lkXG5cdGVycm9yOiAoZXJyb3I6IEVycm9yKSA9PiB2b2lkXG5cdGxvZzogKGxldmVsOiBDQ0xvZ0xldmVsLCBtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWRcblx0dXBkYXRlOiAobG9jYXRpb246IENvbnRyb2xMb2NhdGlvbiwgZGF0YTogQ29tcGFuaW9uQnV0dG9uU3R5bGVQcm9wcykgPT4gdm9pZFxuXHR1cGRhdGVBbGw6IChiYW5rczogeyBsb2NhdGlvbjogQ29udHJvbExvY2F0aW9uOyBkYXRhOiBDb21wYW5pb25CdXR0b25TdHlsZVByb3BzIH1bXSkgPT4gdm9pZFxufVxuXG4vKipcbiAqIFRoZSBDbG91ZENsaWVudCBpcyByZXNwb25zaWJsZSBmb3IgY29ubmVjdGluZyB0byB0aGUgY2xvdWQgYW5kXG4gKiBjb21tdW5pY2F0aW5nIHdpdGggdGhlIGNvbXBhbmlvbiBzZXJ2ZXJcbiAqL1xuZXhwb3J0IGNsYXNzIENsb3VkQ2xpZW50IGV4dGVuZHMgKEV2ZW50RW1pdHRlciBhcyB7IG5ldyAoKTogU3RyaWN0RXZlbnRFbWl0dGVyPEV2ZW50RW1pdHRlciwgQ2xvdWRDbGllbnRFdmVudHM+IH0pIHtcblx0cHJpdmF0ZSBwcm90b2NvbFZlcnNpb24gPSAxXG5cdHByaXZhdGUgY29tcGFuaW9uSWQ6IHN0cmluZ1xuXHRwcml2YXRlIGNvbm5lY3Rpb25zOiBDbG91ZENvbm5lY3Rpb25bXSA9IFtdXG5cdHByaXZhdGUgY3VycmVudFJlZ2lvbnM6IFJlZ2lvbkRlZmluaXRpb25bXSA9IFtdXG5cdHByaXZhdGUgcmVnaW9uczogUmVnaW9uRGVmaW5pdGlvbltdID0gW11cblx0cHJpdmF0ZSBheGlvcyA9IGF4aW9zLmNyZWF0ZSh7XG5cdFx0YmFzZVVSTDogQ0xPVURfVVJMLFxuXHRcdHRpbWVvdXQ6IDEwMDAwLFxuXHR9KVxuXHRwcml2YXRlIGNvdW50ZXIgPSAwXG5cdHByaXZhdGUgY29ubmVjdGluZ0NvdW50ZXIgPSAwXG5cdHByaXZhdGUgbW9kdWxlU3RhdGU6IENDTW9kdWxlU3RhdGUgPSAnSURMRSdcblx0cHJpdmF0ZSBjaGVja2luZ1JlZ2lvbnM6IGJvb2xlYW4gPSBmYWxzZVxuXHRwcml2YXRlIHBpbmdUaW1lcjogTm9kZUpTLlRpbWVyIHwgdW5kZWZpbmVkXG5cdHByaXZhdGUgY2hlY2tDb25uZWN0aW9uVGltZXI6IE5vZGVKUy5UaW1lciB8IHVuZGVmaW5lZFxuXHRwcml2YXRlIHVwZGF0ZUlkczogeyBba2V5OiBzdHJpbmddOiBudW1iZXIgfSA9IHt9XG5cblx0LyoqXG5cdCAqIENyZWF0ZXMgYSBuZXcgQ2xvdWRDbGllbnRcblx0ICpcblx0ICogQHBhcmFtIHJlbW90ZUNvbXBhbmlvbklkIFRoZSBzdXBlciBzZWNyZXQgaWQgdG8gY29ubmVjdCB0byB2aWEgdGhlIGNsb3VkXG5cdCAqL1xuXHRjb25zdHJ1Y3RvcihyZW1vdGVDb21wYW5pb25JZDogc3RyaW5nKSB7XG5cdFx0c3VwZXIoKVxuXHRcdHRoaXMuY29tcGFuaW9uSWQgPSByZW1vdGVDb21wYW5pb25JZFxuXHR9XG5cblx0cHJpdmF0ZSBzZXRTdGF0ZShzdGF0ZTogQ0NNb2R1bGVTdGF0ZSwgbWVzc2FnZT86IHN0cmluZykge1xuXHRcdGlmIChzdGF0ZSAhPT0gdGhpcy5tb2R1bGVTdGF0ZSkge1xuXHRcdFx0dGhpcy5tb2R1bGVTdGF0ZSA9IHN0YXRlXG5cdFx0XHR0aGlzLmVtaXQoJ3N0YXRlJywgc3RhdGUsIG1lc3NhZ2UpXG5cdFx0XHR0aGlzLmNvbm5lY3RpbmdDb3VudGVyID0gMFxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgY2FsY3VsYXRlU3RhdGUoKSB7XG5cdFx0Y29uc3QgY29ubmVjdGVkID0gdGhpcy5jb25uZWN0aW9ucy5maWx0ZXIoKGMpID0+IGMuY29ubmVjdGlvblN0YXRlID09PSAnQ09OTkVDVEVEJykubGVuZ3RoXG5cdFx0Y29uc3QgY29ubmVjdGluZyA9IHRoaXMuY29ubmVjdGlvbnMuZmlsdGVyKChjKSA9PiBjLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ0NPTk5FQ1RJTkcnKS5sZW5ndGhcblx0XHQvL2NvbnN0IGRpc2Nvbm5lY3RlZCA9IHRoaXMuY29ubmVjdGlvbnMuZmlsdGVyKGMgPT4gYy5jb25uZWN0aW9uU3RhdGUgPT09ICdESVNDT05ORUNURUQnKS5sZW5ndGg7XG5cdFx0Y29uc3Qgd2FudHMgPSB0aGlzLnJlZ2lvbnMubGVuZ3RoXG5cblx0XHQvKlxuXHRcdCB0aGlzIGNvZGUgaXMgY29tbWVudGVkIGJlY2F1c2Ugd2Ugd2FudCB0byBrbm93IGlmIHdlIHJlYWNoIHRoZSByZW1vdGUgY29tcGFuaW9uLCBub3QgaWYgd2UgYXJlIGNvbm5lY3RlZCB0byBhbGwgdGhlIHJlZ2lvbnNcblx0XHRpZiAoY29ubmVjdGVkID49IHdhbnRzKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdPSycpIC8vIFRPRE86IG9ubHkgaWYgcmVtb3RlIGNvbXBhbmlvbiBpcyBhbHNvIE9LXG5cdFx0fSBlbHNlIGlmIChjb25uZWN0ZWQgKyBjb25uZWN0aW5nID09PSAwKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdFUlJPUicsICdOb3QgY29ubmVjdGluZycpXG5cdFx0fSBlbHNlIGlmIChjb25uZWN0ZWQgPT09IDApIHtcblx0XHRcdHRoaXMuc2V0U3RhdGUoJ0VSUk9SJywgJ05vIGNvbm5lY3Rpb25zIGVzdGFibGlzaGVkJylcblx0XHR9IGVsc2UgaWYgKGNvbm5lY3RlZCA8IHdhbnRzKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdXQVJOSU5HJywgYE9ubHkgJHtjb25uZWN0ZWR9IG9mICR7d2FudHN9IGNvbm5lY3Rpb25zIGVzdGFibGlzaGVkYClcblx0XHR9Ki9cblx0XHRpZiAoIXRoaXMuY2hlY2tpbmdSZWdpb25zICYmIHdhbnRzID4gMCAmJiBjb25uZWN0ZWQgPT09IDApIHtcblx0XHRcdGlmICh0aGlzLmNvbm5lY3RpbmdDb3VudGVyKysgPiAzKSB7XG5cdFx0XHRcdC8vY29uc29sZS5sb2codGhpcy5jaGVja2luZ1JlZ2lvbnMsIHdhbnRzLCBjb25uZWN0ZWQpXG5cdFx0XHRcdHRoaXMuc2V0U3RhdGUoJ0VSUk9SJywgJ05vIHJlbGV2YW50IHJlZ2lvbnMgYXJlIHJlYWNoYWJsZScpXG5cdFx0XHRcdHRoaXMuZW1pdCgnbG9nJywgJ2Vycm9yJywgJ05vIHJlbGV2YW50IHJlZ2lvbnMgYXJlIHJlYWNoYWJsZSwgY2hlY2sgeW91ciBpbnRlcm5ldCBjb25uZWN0aW9uJylcblx0XHRcdFx0dGhpcy5jb25uZWN0aW5nQ291bnRlciA9IDBcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBNYWtlIHN1cmUgd2UgdGVzdCB0aGUgY29ubmVjdGlvbnMgaW1tZWRpYXRlbHkgYWZ0ZXIgd2UgaGF2ZSBjb25uZWN0ZWQgdG8gYWxsIHJlZ2lvbnNcblx0XHQvLyB0byBnZXQgYSBmYXN0IG1haW4gc3RhdGUgdXBkYXRlXG5cdFx0aWYgKGNvbm5lY3RlZCA9PSB3YW50cykge1xuXHRcdFx0dGhpcy5waW5nQ29tcGFuaW9uKClcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIHVwZGF0ZVJlZ2lvbnNGcm9tUkVTVCgpIHtcblx0XHR0aGlzLmNoZWNraW5nUmVnaW9ucyA9IHRydWVcblx0XHRjb25zdCBuZXdSZWdpb25zID0gYXdhaXQgdGhpcy5mZXRjaFJlZ2lvbnNGb3IodGhpcy5jb21wYW5pb25JZClcblx0XHR0aGlzLmNoZWNraW5nUmVnaW9ucyA9IGZhbHNlXG5cdFx0aWYgKG5ld1JlZ2lvbnMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aGlzLmVtaXQoXG5cdFx0XHRcdCdsb2cnLFxuXHRcdFx0XHQnZXJyb3InLFxuXHRcdFx0XHQnUmVtb3RlIGNvbXBhbmlvbiBkb2VzIG5vdCBzZWVtIHRvIGJlIHJlZ2lzdGVyZWQgd2l0aCB0aGUgY2xvdWQsIHJldHJ5aW5nIGluIDEwIHNlY29uZHMnXG5cdFx0XHQpXG5cdFx0XHRpZiAodGhpcy5yZWdpb25zLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0dGhpcy5yZWdpb25zID0gbmV3UmVnaW9uc1xuXHRcdFx0XHR0aGlzLnJlY2FsY3VsYXRlUmVnaW9ucygpXG5cdFx0XHR9XG5cdFx0XHRyZXR1cm5cblx0XHR9XG5cdFx0dGhpcy5yZWdpb25zID0gbmV3UmVnaW9uc1xuXHRcdHRoaXMucmVjYWxjdWxhdGVSZWdpb25zKClcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgcmVjYWxjdWxhdGVSZWdpb25zKCkge1xuXHRcdGNvbnN0IHJlZ2lvbnNUb1JlbW92ZSA9IHRoaXMuY3VycmVudFJlZ2lvbnMuZmlsdGVyKChyKSA9PiAhdGhpcy5yZWdpb25zLmZpbmQoKG5yKSA9PiBuci5pZCA9PT0gci5pZCkpXG5cdFx0Y29uc3QgcmVnaW9uc1RvQWRkID0gdGhpcy5yZWdpb25zLmZpbHRlcigocikgPT4gIXRoaXMuY3VycmVudFJlZ2lvbnMuZmluZCgobnIpID0+IG5yLmlkID09PSByLmlkKSlcblxuXHRcdGZvciAoY29uc3QgcmVnaW9uIG9mIHJlZ2lvbnNUb1JlbW92ZSkge1xuXHRcdFx0Y29uc3QgY29ubmVjdGlvbiA9IHRoaXMuY29ubmVjdGlvbnMuZmluZCgoYykgPT4gYy5yZWdpb25JZCA9PT0gcmVnaW9uLmlkKVxuXHRcdFx0aWYgKGNvbm5lY3Rpb24pIHtcblx0XHRcdFx0YXdhaXQgY29ubmVjdGlvbi5kZXN0cm95KClcblx0XHRcdFx0dGhpcy5jb25uZWN0aW9ucyA9IHRoaXMuY29ubmVjdGlvbnMuZmlsdGVyKChjKSA9PiBjLnJlZ2lvbklkICE9PSByZWdpb24uaWQpXG5cdFx0XHR9XG5cdFx0XHR0aGlzLmN1cnJlbnRSZWdpb25zID0gdGhpcy5jdXJyZW50UmVnaW9ucy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IHJlZ2lvbi5pZClcblx0XHRcdHRoaXMuZW1pdCgnbG9nJywgJ2luZm8nLCBgUmVnaW9uICR7cmVnaW9uLmxhYmVsfSByZW1vdmVkYClcblx0XHR9XG5cblx0XHRmb3IgKGNvbnN0IHJlZ2lvbiBvZiByZWdpb25zVG9BZGQpIHtcblx0XHRcdGNvbnN0IG5ld0Nvbm5lY3Rpb24gPSBuZXcgQ2xvdWRDb25uZWN0aW9uKHJlZ2lvbi5pZCwgcmVnaW9uLmhvc3RuYW1lLCB0aGlzLmNvbXBhbmlvbklkKVxuXHRcdFx0dGhpcy5jb25uZWN0aW9ucyA9IFsuLi50aGlzLmNvbm5lY3Rpb25zLCBuZXdDb25uZWN0aW9uXVxuXHRcdFx0dGhpcy5jdXJyZW50UmVnaW9ucyA9IFsuLi50aGlzLmN1cnJlbnRSZWdpb25zLCByZWdpb25dXG5cblx0XHRcdG5ld0Nvbm5lY3Rpb24ub24oJ3NvY2tldHN0YXRlJywgKHN0YXRlKSA9PiB7XG5cdFx0XHRcdC8vY29uc29sZS5sb2coJ0RFQlVHOyBSZWdpb24gJW8gY2hhbmdlZCBzdGF0ZSB0byAlbycsIHJlZ2lvbi5pZCwgc3RhdGUpXG5cdFx0XHRcdHRoaXMuY2FsY3VsYXRlU3RhdGUoKVxuXHRcdFx0fSlcblxuXHRcdFx0bmV3Q29ubmVjdGlvbi5vbignYmFua3MnLCAoYmFua3MpID0+IHtcblx0XHRcdFx0aWYgKHRoaXMudXBkYXRlSWRzW2JhbmtzLnVwZGF0ZUlkXSkgcmV0dXJuXG5cdFx0XHRcdHRoaXMudXBkYXRlSWRzW2JhbmtzLnVwZGF0ZUlkXSA9IERhdGUubm93KClcblxuXHRcdFx0XHQvLyBJbiBwcm90b2NvbCB2MSsgd2UgaGF2ZSBsb2NhdGlvbiBwcm9wZXJ0eVxuXHRcdFx0XHRiYW5rcy5kYXRhID0gYmFua3MuZGF0YS5tYXAoKGJhbmspID0+ICh7XG5cdFx0XHRcdFx0Li4uYmFuayxcblx0XHRcdFx0XHRsb2NhdGlvbjpcblx0XHRcdFx0XHRcdGJhbmsucCA+PSAxID8gYmFuay5sb2NhdGlvbiA6IHsgcGFnZU51bWJlcjogYmFuay5wYWdlID8/IDAsIHJvdzogYmFuay5iYW5rID8/IDAsIGNvbHVtbjogMCB9LFxuXHRcdFx0XHR9KSlcblx0XHRcdFx0dGhpcy5lbWl0KCd1cGRhdGVBbGwnLCBiYW5rcy5kYXRhIGFzIE11bHRpQmFuaylcblx0XHRcdH0pXG5cblx0XHRcdG5ld0Nvbm5lY3Rpb24ub24oJ2JhbmsnLCAoYmFuaykgPT4ge1xuXHRcdFx0XHRpZiAodGhpcy51cGRhdGVJZHNbYmFuay51cGRhdGVJZF0pIHJldHVyblxuXHRcdFx0XHRpZiAoIWJhbmsucCkge1xuXHRcdFx0XHRcdGJhbmsubG9jYXRpb24gPSB7XG5cdFx0XHRcdFx0XHRwYWdlTnVtYmVyOiBiYW5rLnBhZ2UgPz8gMCxcblx0XHRcdFx0XHRcdHJvdzogYmFuay5iYW5rID8/IDAsXG5cdFx0XHRcdFx0XHRjb2x1bW46IDAsXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdHRoaXMuZW1pdCgndXBkYXRlJywgYmFuay5sb2NhdGlvbiwgYmFuay5kYXRhKVxuXHRcdFx0XHR0aGlzLnVwZGF0ZUlkc1tiYW5rLnVwZGF0ZUlkXSA9IERhdGUubm93KClcblx0XHRcdH0pXG5cblx0XHRcdG5ld0Nvbm5lY3Rpb24ub24oJ3JlZ2lvbnMnLCAocmVnaW9ucykgPT4ge1xuXHRcdFx0XHQvL2NvbnNvbGUubG9nKCdOZXcgcmVnaW9uczogJywgcmVnaW9ucylcblx0XHRcdFx0Ly9jb25zb2xlLmxvZygnT2xkIHJlZ2lvbnM6ICcsIHRoaXMucmVnaW9ucylcblx0XHRcdH0pXG5cblx0XHRcdHZvaWQgbmV3Q29ubmVjdGlvbi5pbml0KClcblx0XHRcdHRoaXMuZW1pdCgnbG9nJywgJ2luZm8nLCBgUmVnaW9uICR7cmVnaW9uLmxhYmVsfSBhZGRlZGApXG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBmZXRjaFJlZ2lvbnNGb3IoY29tcGFuaW9uSWQ6IHN0cmluZykge1xuXHRcdC8vaWYgKHRoaXMuY291bnRlcisrIDwgMikgcmV0dXJuIFtdXG5cdFx0dHJ5IHtcblx0XHRcdHJldHVybiAoYXdhaXQgdGhpcy5heGlvcy5nZXQoYC9pbmZyYXN0cnVjdHVyZS9jbG91ZC9yZWdpb25zL2NvbXBhbmlvbi8ke2NvbXBhbmlvbklkfWApKS5kYXRhIGFzIHtcblx0XHRcdFx0aWQ6IHN0cmluZ1xuXHRcdFx0XHRob3N0bmFtZTogc3RyaW5nXG5cdFx0XHRcdGxvY2F0aW9uOiBzdHJpbmdcblx0XHRcdFx0bGFiZWw6IHN0cmluZ1xuXHRcdFx0fVtdXG5cdFx0fSBjYXRjaCAoZSkge1xuXHRcdFx0cmV0dXJuIFtdXG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIHBpbmdpbmcgaXMgc2VudCBpbmRpdmlkdWFsbHksIGFuZCBjb3VudGVkIHVwLCBpbiBjb250cmFzdCB0byBjbGllbnRDb21tYW5kXG5cdCAqL1xuXHRhc3luYyBwaW5nQ29tcGFuaW9uKCkge1xuXHRcdGNvbnN0IG9ubGluZUNvbm5lY3Rpb25zID0gdGhpcy5jb25uZWN0aW9ucy5maWx0ZXIoKGNvbm5lY3Rpb24pID0+IGNvbm5lY3Rpb24uY29ubmVjdGlvblN0YXRlID09PSAnQ09OTkVDVEVEJylcblxuXHRcdGNvbnN0IGFsbFRoZVByb21pc2VzID0gb25saW5lQ29ubmVjdGlvbnMubWFwKChjb25uZWN0aW9uKSA9PiB7XG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0XHRjb25zdCBjYWxsZXJJZCA9IGdlbmVyYXRlUmFuZG9tVVVJRCgpXG5cdFx0XHRcdGNvbnN0IHJlcGx5Q2hhbm5lbCA9ICdjb21wYW5pb25Qcm9jUmVzdWx0OicgKyBjYWxsZXJJZFxuXG5cdFx0XHRcdGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHRjb25uZWN0aW9uLnNvY2tldD8udW5zdWJzY3JpYmUocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdGNvbm5lY3Rpb24uc29ja2V0Py5jbG9zZUNoYW5uZWwocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoJ1RpbWVvdXQnKSlcblx0XHRcdFx0fSwgQ09NUEFOSU9OX1BJTkdfVElNRU9VVClcblxuXHRcdFx0XHQ7KGFzeW5jICgpID0+IHtcblx0XHRcdFx0XHRmb3IgYXdhaXQgKGxldCBkYXRhIG9mIGNvbm5lY3Rpb24uc29ja2V0LnN1YnNjcmliZShyZXBseUNoYW5uZWwpKSB7XG5cdFx0XHRcdFx0XHQvL2NvbnNvbGUubG9nKCdERUJVRzogR290IHJlcGx5IGZyb20gY29tcGFuaW9uJywgZGF0YSlcblx0XHRcdFx0XHRcdGNvbm5lY3Rpb24uc29ja2V0Py51bnN1YnNjcmliZShyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0XHRjb25uZWN0aW9uLnNvY2tldD8uY2xvc2VDaGFubmVsKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHRcdGNsZWFyVGltZW91dCh0aW1lb3V0KVxuXHRcdFx0XHRcdFx0cmVzb2x2ZSh0cnVlKVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSkoKVxuXG5cdFx0XHRcdGNvbm5lY3Rpb24uc29ja2V0Py50cmFuc21pdFB1Ymxpc2g/LihgY29tcGFuaW9uUHJvYzoke3RoaXMuY29tcGFuaW9uSWR9OnBpbmdgLCB7IGFyZ3M6IFtdLCBjYWxsZXJJZCB9KVxuXHRcdFx0fSlcblx0XHR9KVxuXG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKGFsbFRoZVByb21pc2VzKVxuXHRcdGNvbnN0IHN1Y2Nlc3MgPSByZXN1bHQuZmlsdGVyKChyKSA9PiByLnN0YXR1cyA9PT0gJ2Z1bGZpbGxlZCcpLmxlbmd0aFxuXHRcdGNvbnN0IGZhaWxlZCA9IHJlc3VsdC5maWx0ZXIoKHIpID0+IHIuc3RhdHVzID09PSAncmVqZWN0ZWQnKS5sZW5ndGhcblxuXHRcdGlmIChzdWNjZXNzID09PSAwICYmIHRoaXMucmVnaW9ucy5sZW5ndGggPiAwKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdFUlJPUicsICdSZW1vdGUgY29tcGFuaW9uIGlzIHVucmVhY2hhYmxlJylcblx0XHRcdHRoaXMuZW1pdChcblx0XHRcdFx0J2xvZycsXG5cdFx0XHRcdCdlcnJvcicsXG5cdFx0XHRcdGBSZW1vdGUgY29tcGFuaW9uIGlzIHVucmVhY2hhYmxlIHZpYSBpdHMgJHt0aGlzLnJlZ2lvbnMubGVuZ3RofSByZWdpb24gY29ubmVjdGlvbiR7XG5cdFx0XHRcdFx0dGhpcy5yZWdpb25zLmxlbmd0aCAhPT0gMSA/ICdzJyA6ICcnXG5cdFx0XHRcdH1gXG5cdFx0XHQpXG5cdFx0fSBlbHNlIGlmIChmYWlsZWQgPiAwKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdXQVJOSU5HJywgYFJlbW90ZSBjb21wYW5pb24gaXMgdW5yZWFjaGFibGUgdGhyb3VnaCBzb21lIHJlZ2lvbnNgKVxuXHRcdFx0dGhpcy5lbWl0KFxuXHRcdFx0XHQnbG9nJyxcblx0XHRcdFx0J3dhcm5pbmcnLFxuXHRcdFx0XHRgUmVtb3RlIGNvbXBhbmlvbiBpcyBvbmx5IHJlYWNoYWJsZSBvbiAke3N1Y2Nlc3N9IG9mICR7b25saW5lQ29ubmVjdGlvbnMubGVuZ3RofSByZWdpb25zYFxuXHRcdFx0KVxuXHRcdH0gZWxzZSBpZiAoc3VjY2VzcyA9PT0gb25saW5lQ29ubmVjdGlvbnMubGVuZ3RoICYmIG9ubGluZUNvbm5lY3Rpb25zLmxlbmd0aCA+IDApIHtcblx0XHRcdHRoaXMuc2V0U3RhdGUoJ09LJylcblx0XHR9XG5cdH1cblxuXHRhc3luYyBjbGllbnRDb21tYW5kKG5hbWU6IHN0cmluZywgLi4uYXJnczogYW55W10pIHtcblx0XHRjb25zdCBjYWxsZXJJZCA9IGdlbmVyYXRlUmFuZG9tVVVJRCgpXG5cdFx0Y29uc3QgcmVwbHlDaGFubmVsID0gJ2NvbXBhbmlvblByb2NSZXN1bHQ6JyArIGNhbGxlcklkXG5cblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0Y29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dGhpcy5jb25uZWN0aW9uc1xuXHRcdFx0XHRcdC5maWx0ZXIoKGNvbm5lY3Rpb24pID0+IGNvbm5lY3Rpb24uY29ubmVjdGlvblN0YXRlID09PSAnQ09OTkVDVEVEJylcblx0XHRcdFx0XHQuZm9yRWFjaCgoY29ubmVjdGlvbikgPT4ge1xuXHRcdFx0XHRcdFx0Y29ubmVjdGlvbi5zb2NrZXQ/LnVuc3Vic2NyaWJlKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHRcdGNvbm5lY3Rpb24uc29ja2V0Py5jbG9zZUNoYW5uZWwocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdH0pXG5cdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoJ0NsaWVudENvbW1hbmQgdGltZW91dCcpKVxuXHRcdFx0fSwgMTAwMDApXG5cblx0XHRcdGxldCBpc0hhbmRlbGVkID0gZmFsc2Vcblx0XHRcdHRoaXMuY29ubmVjdGlvbnNcblx0XHRcdFx0LmZpbHRlcigoY29ubmVjdGlvbikgPT4gY29ubmVjdGlvbi5jb25uZWN0aW9uU3RhdGUgPT09ICdDT05ORUNURUQnKVxuXHRcdFx0XHQuZm9yRWFjaCgoY29ubmVjdGlvbikgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHNvY2tldCA9IGNvbm5lY3Rpb24uc29ja2V0XG5cdFx0XHRcdFx0Oyhhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0XHRmb3IgYXdhaXQgKGxldCBkYXRhIG9mIHNvY2tldD8uc3Vic2NyaWJlKHJlcGx5Q2hhbm5lbCkpIHtcblx0XHRcdFx0XHRcdFx0aWYgKGlzSGFuZGVsZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRzb2NrZXQ/LnVuc3Vic2NyaWJlKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHRcdFx0XHRzb2NrZXQ/LmNsb3NlQ2hhbm5lbChyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuXG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHQvL1x0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coJ0RFQlVHOyBHb3QgcmVzcG9uc2UgZm9yIGNvbW1hbmQgJW8nLCB0aGlzLmNvbXBhbmlvbklkICsgJzonICsgbmFtZSlcblx0XHRcdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVyKVxuXHRcdFx0XHRcdFx0XHRpc0hhbmRlbGVkID0gdHJ1ZVxuXG5cdFx0XHRcdFx0XHRcdGlmIChkYXRhLmVycm9yKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcigncnBjIGVycm9yOiAnICsgZGF0YS5lcnJvcikpXG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0cmVzb2x2ZShkYXRhLnJlc3VsdClcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdHNvY2tldD8udW5zdWJzY3JpYmUocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdFx0XHRzb2NrZXQ/LmNsb3NlQ2hhbm5lbChyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0XHRcdGJyZWFrXG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSkoKVxuXHRcdFx0XHRcdC8qXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coXG5cdFx0XHRcdFx0XHQnREVCVUc7IFNlbmRpbmcgY29tbWFuZCB0byAlbzogJW8nLFxuXHRcdFx0XHRcdFx0Y29ubmVjdGlvbi5yZWdpb25JZCxcblx0XHRcdFx0XHRcdGBjb21wYW5pb25Qcm9jOiR7dGhpcy5jb21wYW5pb25JZH06JHtuYW1lfWBcblx0XHRcdFx0XHQpKi9cblx0XHRcdFx0XHRzb2NrZXQ/LnRyYW5zbWl0UHVibGlzaChgY29tcGFuaW9uUHJvYzoke3RoaXMuY29tcGFuaW9uSWR9OiR7bmFtZX1gLCB7IGFyZ3MsIGNhbGxlcklkIH0pXG5cdFx0XHRcdH0pXG5cdFx0fSlcblx0fVxuXG5cdC8qKlxuXHQgKiBJbml0aWFsaXplcyB0aGUgY29ubmVjdGlvbiB0byB0aGUgY2xvdWRcblx0ICovXG5cdGFzeW5jIGluaXQoKSB7XG5cdFx0dGhpcy5waW5nVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG5cdFx0XHR0aGlzLnBpbmdDb21wYW5pb24oKVxuXG5cdFx0XHQvLyBDbGVhbnVwIHVwZGF0ZSBpZHNcblx0XHRcdGZvciAobGV0IGtleSBpbiB0aGlzLnVwZGF0ZUlkcykge1xuXHRcdFx0XHRpZiAoRGF0ZS5ub3coKSAtIHRoaXMudXBkYXRlSWRzW2tleV0gPj0gMzAwMDApIHtcblx0XHRcdFx0XHRkZWxldGUgdGhpcy51cGRhdGVJZHNba2V5XVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSwgQ09NUEFOSU9OX1BJTkdfVElNRU9VVCArIDIwMDApXG5cblx0XHR0aGlzLnNldFN0YXRlKCdXQVJOSU5HJywgJ0Nvbm5lY3RpbmcgdG8gY2xvdWQnKVxuXHRcdHRoaXMuY2hlY2tDb25uZWN0aW9uVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG5cdFx0XHR0aGlzLnVwZGF0ZVJlZ2lvbnNGcm9tUkVTVCgpXG5cdFx0fSwgMTAwMDApXG5cblx0XHRhd2FpdCB0aGlzLnVwZGF0ZVJlZ2lvbnNGcm9tUkVTVCgpXG5cdH1cblxuXHQvKipcblx0ICogRGVzdHJveXMgcnVubmluZyB0aW1lcnMgYW5kIGNvbm5lY3Rpb25zXG5cdCAqL1xuXHRkZXN0cm95KCkge1xuXHRcdGlmICh0aGlzLnBpbmdUaW1lcikge1xuXHRcdFx0Y2xlYXJJbnRlcnZhbCh0aGlzLnBpbmdUaW1lcilcblx0XHR9XG5cdFx0aWYgKHRoaXMuY2hlY2tDb25uZWN0aW9uVGltZXIpIHtcblx0XHRcdGNsZWFySW50ZXJ2YWwodGhpcy5jaGVja0Nvbm5lY3Rpb25UaW1lcilcblx0XHR9XG5cdFx0dGhpcy5jb25uZWN0aW9ucy5mb3JFYWNoKChjb25uZWN0aW9uKSA9PiB7XG5cdFx0XHRjb25uZWN0aW9uLmRlc3Ryb3koKVxuXHRcdH0pXG5cdFx0dGhpcy5jb25uZWN0aW9ucyA9IFtdXG5cdFx0dGhpcy5yZWdpb25zID0gW11cblx0fVxuXG5cdGNvbm5lY3QoKSB7fVxufVxuIl19