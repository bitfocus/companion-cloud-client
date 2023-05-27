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
                console.log(this.checkingRegions, wants, connected);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290Ijoic3JjLyIsInNvdXJjZXMiOlsiaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsdURBQW1EO0FBQ25ELGlDQUF5QjtBQUV6QixxQ0FBdUM7QUFHdkMsOEVBQThFO0FBQzlFLHVFQUF1RTtBQUN2RSxNQUFNLGtCQUFrQixHQUFHLEdBQUcsRUFBRTtJQUMvQixJQUFJLENBQUMsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLE9BQU8sRUFBRSxDQUFBO0lBRTVCLE9BQU8sc0NBQXNDLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxVQUFVLENBQUM7UUFDekUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLEdBQUcsRUFBRSxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFBO1FBQzdDLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQTtRQUN0QixPQUFPLENBQUMsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUE7SUFDdEQsQ0FBQyxDQUFDLENBQUE7QUFDSCxDQUFDLENBQUE7QUFFRCxNQUFNLFNBQVMsR0FDZCxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsS0FBSyxZQUFZLENBQUMsQ0FBQyxDQUFDLDRCQUE0QixDQUFDLENBQUMsQ0FBQyxvQ0FBb0MsQ0FBQTtBQUU1RyxNQUFNLHNCQUFzQixHQUFHLElBQUksQ0FBQTtBQVNuQyxNQUFNLG9CQUFxQixTQUFRLEtBQUs7SUFDdkMsWUFBWSxPQUFlO1FBQzFCLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQTtRQUNkLElBQUksQ0FBQyxJQUFJLEdBQUcsc0JBQXNCLENBQUE7SUFDbkMs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O29CQUM5QyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUE7aUJBQzFCO2FBQ0Q7UUFDRixDQUFDLEVBQUUsc0JBQXNCLEdBQUcsSUFBSSxDQUFDLENBQUE7UUFFakMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxTQUFTLEVBQUUscUJBQXFCLENBQUMsQ0FBQTtRQUMvQyxJQUFJLENBQUMsb0JBQW9CLEdBQUcsV0FBVyxDQUFDLEdBQUcsRUFBRTtZQUM1QyxJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQTtRQUM3QixDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFVixNQUFNLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxDQUFBO0lBQ25DLENBQUM7SUFFRDs7T0FFRztJQUNILE9BQU87UUFDTixJQUFJLElBQUksQ0FBQyxTQUFTLEVBQUU7WUFDbkIsYUFBYSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQTtTQUM3QjtRQUNELElBQUksSUFBSSxDQUFDLG9CQUFvQixFQUFFO1lBQzlCLGFBQWEsQ0FBQyxJQUFJLENBQUMsb0JBQW9CLENBQUMsQ0FBQTtTQUN4QztRQUNELElBQUksQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUMsVUFBVSxFQUFFLEVBQUU7WUFDdkMsVUFBVSxDQUFDLE9BQU8sRUFBRSxDQUFBO1FBQ3JCLENBQUMsQ0FBQyxDQUFBO1FBQ0YsSUFBSSxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUE7UUFDckIsSUFBSSxDQUFDLE9BQU8sR0FBRyxFQUFFLENBQUE7SUFDbEIsQ0FBQztJQUVELE9BQU8sS0FBSSxDQUFDO0NBQ1o7QUEzU0Qsa0NBMlNDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ2xvdWRDb25uZWN0aW9uIH0gZnJvbSAnLi9jbG91ZGNvbm5lY3Rpb24nXG5pbXBvcnQgYXhpb3MgZnJvbSAnYXhpb3MnXG5pbXBvcnQgU3RyaWN0RXZlbnRFbWl0dGVyIGZyb20gJ3N0cmljdC1ldmVudC1lbWl0dGVyLXR5cGVzJ1xuaW1wb3J0IHsgRXZlbnRFbWl0dGVyIH0gZnJvbSAnLi9ldmVudHMnXG5pbXBvcnQgeyBDb21wYW5pb25CdXR0b25TdHlsZVByb3BzLCBNdWx0aUJhbmsgfSBmcm9tICcuL3R5cGVzJ1xuXG4vLyBXZSBkb24ndCB1c2UgZXh0ZXJuYWwgbW9kdWxlcyBmb3IgdGhpcyBvciBldmVudGVtaXR0ZXIsIHNvIHRoYXQgdGhpcyBtb2R1bGVcbi8vIGNhbiBiZSB1c2VkIG1vcmUgZWFzaWx5IGZvciBub2RlL3dlYi9lbGVjdHJvbi9yZWFjdC1uYXRpdmUgcHJvamVjdHMuXG5jb25zdCBnZW5lcmF0ZVJhbmRvbVVVSUQgPSAoKSA9PiB7XG5cdGxldCBkID0gbmV3IERhdGUoKS5nZXRUaW1lKClcblxuXHRyZXR1cm4gJ3h4eHh4eHh4LXh4eHgtNHh4eC15eHh4LXh4eHh4eHh4eHh4eCcucmVwbGFjZSgvW3h5XS9nLCBmdW5jdGlvbiAoYykge1xuXHRcdGNvbnN0IHIgPSAoKGQgKyBNYXRoLnJhbmRvbSgpICogMTYpICUgMTYpIHwgMFxuXHRcdGQgPSBNYXRoLmZsb29yKGQgLyAxNilcblx0XHRyZXR1cm4gKGMgPT09ICd4JyA/IHIgOiAociAmIDB4MykgfCAweDgpLnRvU3RyaW5nKDE2KVxuXHR9KVxufVxuXG5jb25zdCBDTE9VRF9VUkwgPVxuXHRwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gJ3Byb2R1Y3Rpb24nID8gJ2h0dHBzOi8vYXBpLmJpdGZvY3VzLmlvL3YxJyA6ICdodHRwczovL2FwaS1zdGFnaW5nLmJpdGZvY3VzLmlvL3YxJ1xuXG5jb25zdCBDT01QQU5JT05fUElOR19USU1FT1VUID0gNTAwMFxuXG5leHBvcnQgdHlwZSBSZWdpb25EZWZpbml0aW9uID0ge1xuXHRpZDogc3RyaW5nXG5cdGhvc3RuYW1lOiBzdHJpbmdcblx0bG9jYXRpb246IHN0cmluZ1xuXHRsYWJlbDogc3RyaW5nXG59XG5cbmNsYXNzIFJlZ2lvbkZldGNoRXhjZXB0aW9uIGV4dGVuZHMgRXJyb3Ige1xuXHRjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcblx0XHRzdXBlcihtZXNzYWdlKVxuXHRcdHRoaXMubmFtZSA9ICdSZWdpb25GZXRjaEV4Y2VwdGlvbidcblx0fVxufVxuXG5leHBvcnQgdHlwZSBDQ01vZHVsZVN0YXRlID0gJ0lETEUnIHwgJ1dBUk5JTkcnIHwgJ0VSUk9SJyB8ICdPSydcbmV4cG9ydCB0eXBlIENDTG9nTGV2ZWwgPSAnZXJyb3InIHwgJ3dhcm5pbmcnIHwgJ2luZm8nIHwgJ2RlYnVnJ1xuXG5pbnRlcmZhY2UgQ2xvdWRDbGllbnRFdmVudHMge1xuXHRzdGF0ZTogKHN0YXRlOiBDQ01vZHVsZVN0YXRlLCBtZXNzYWdlPzogc3RyaW5nKSA9PiB2b2lkXG5cdGVycm9yOiAoZXJyb3I6IEVycm9yKSA9PiB2b2lkXG5cdGxvZzogKGxldmVsOiBDQ0xvZ0xldmVsLCBtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWRcblx0dXBkYXRlOiAocGFnZTogbnVtYmVyLCBiYW5rOiBudW1iZXIsIGRhdGE6IENvbXBhbmlvbkJ1dHRvblN0eWxlUHJvcHMpID0+IHZvaWRcblx0dXBkYXRlQWxsOiAoYmFua3M6IHsgcGFnZTogbnVtYmVyOyBiYW5rOiBudW1iZXI7IGRhdGE6IENvbXBhbmlvbkJ1dHRvblN0eWxlUHJvcHMgfVtdKSA9PiB2b2lkXG59XG5cbi8qKlxuICogVGhlIENsb3VkQ2xpZW50IGlzIHJlc3BvbnNpYmxlIGZvciBjb25uZWN0aW5nIHRvIHRoZSBjbG91ZCBhbmRcbiAqIGNvbW11bmljYXRpbmcgd2l0aCB0aGUgY29tcGFuaW9uIHNlcnZlclxuICovXG5leHBvcnQgY2xhc3MgQ2xvdWRDbGllbnQgZXh0ZW5kcyAoRXZlbnRFbWl0dGVyIGFzIHsgbmV3ICgpOiBTdHJpY3RFdmVudEVtaXR0ZXI8RXZlbnRFbWl0dGVyLCBDbG91ZENsaWVudEV2ZW50cz4gfSkge1xuXHRwcml2YXRlIGNvbXBhbmlvbklkOiBzdHJpbmdcblx0cHJpdmF0ZSBjb25uZWN0aW9uczogQ2xvdWRDb25uZWN0aW9uW10gPSBbXVxuXHRwcml2YXRlIGN1cnJlbnRSZWdpb25zOiBSZWdpb25EZWZpbml0aW9uW10gPSBbXVxuXHRwcml2YXRlIHJlZ2lvbnM6IFJlZ2lvbkRlZmluaXRpb25bXSA9IFtdXG5cdHByaXZhdGUgYXhpb3MgPSBheGlvcy5jcmVhdGUoe1xuXHRcdGJhc2VVUkw6IENMT1VEX1VSTCxcblx0XHR0aW1lb3V0OiAxMDAwMCxcblx0fSlcblx0cHJpdmF0ZSBjb3VudGVyID0gMFxuXHRwcml2YXRlIGNvbm5lY3RpbmdDb3VudGVyID0gMFxuXHRwcml2YXRlIG1vZHVsZVN0YXRlOiBDQ01vZHVsZVN0YXRlID0gJ0lETEUnXG5cdHByaXZhdGUgY2hlY2tpbmdSZWdpb25zOiBib29sZWFuID0gZmFsc2Vcblx0cHJpdmF0ZSBwaW5nVGltZXI6IE5vZGVKUy5UaW1lciB8IHVuZGVmaW5lZFxuXHRwcml2YXRlIGNoZWNrQ29ubmVjdGlvblRpbWVyOiBOb2RlSlMuVGltZXIgfCB1bmRlZmluZWRcblx0cHJpdmF0ZSB1cGRhdGVJZHM6IHsgW2tleTogc3RyaW5nXTogbnVtYmVyIH0gPSB7fVxuXG5cdC8qKlxuXHQgKiBDcmVhdGVzIGEgbmV3IENsb3VkQ2xpZW50XG5cdCAqXG5cdCAqIEBwYXJhbSByZW1vdGVDb21wYW5pb25JZCBUaGUgc3VwZXIgc2VjcmV0IGlkIHRvIGNvbm5lY3QgdG8gdmlhIHRoZSBjbG91ZFxuXHQgKi9cblx0Y29uc3RydWN0b3IocmVtb3RlQ29tcGFuaW9uSWQ6IHN0cmluZykge1xuXHRcdHN1cGVyKClcblx0XHR0aGlzLmNvbXBhbmlvbklkID0gcmVtb3RlQ29tcGFuaW9uSWRcblx0fVxuXG5cdHByaXZhdGUgc2V0U3RhdGUoc3RhdGU6IENDTW9kdWxlU3RhdGUsIG1lc3NhZ2U/OiBzdHJpbmcpIHtcblx0XHRpZiAoc3RhdGUgIT09IHRoaXMubW9kdWxlU3RhdGUpIHtcblx0XHRcdHRoaXMubW9kdWxlU3RhdGUgPSBzdGF0ZVxuXHRcdFx0dGhpcy5lbWl0KCdzdGF0ZScsIHN0YXRlLCBtZXNzYWdlKVxuXHRcdFx0dGhpcy5jb25uZWN0aW5nQ291bnRlciA9IDBcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGNhbGN1bGF0ZVN0YXRlKCkge1xuXHRcdGNvbnN0IGNvbm5lY3RlZCA9IHRoaXMuY29ubmVjdGlvbnMuZmlsdGVyKChjKSA9PiBjLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ0NPTk5FQ1RFRCcpLmxlbmd0aFxuXHRcdGNvbnN0IGNvbm5lY3RpbmcgPSB0aGlzLmNvbm5lY3Rpb25zLmZpbHRlcigoYykgPT4gYy5jb25uZWN0aW9uU3RhdGUgPT09ICdDT05ORUNUSU5HJykubGVuZ3RoXG5cdFx0Ly9jb25zdCBkaXNjb25uZWN0ZWQgPSB0aGlzLmNvbm5lY3Rpb25zLmZpbHRlcihjID0+IGMuY29ubmVjdGlvblN0YXRlID09PSAnRElTQ09OTkVDVEVEJykubGVuZ3RoO1xuXHRcdGNvbnN0IHdhbnRzID0gdGhpcy5yZWdpb25zLmxlbmd0aFxuXG5cdFx0Lypcblx0XHQgdGhpcyBjb2RlIGlzIGNvbW1lbnRlZCBiZWNhdXNlIHdlIHdhbnQgdG8ga25vdyBpZiB3ZSByZWFjaCB0aGUgcmVtb3RlIGNvbXBhbmlvbiwgbm90IGlmIHdlIGFyZSBjb25uZWN0ZWQgdG8gYWxsIHRoZSByZWdpb25zXG5cdFx0aWYgKGNvbm5lY3RlZCA+PSB3YW50cykge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnT0snKSAvLyBUT0RPOiBvbmx5IGlmIHJlbW90ZSBjb21wYW5pb24gaXMgYWxzbyBPS1xuXHRcdH0gZWxzZSBpZiAoY29ubmVjdGVkICsgY29ubmVjdGluZyA9PT0gMCkge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnRVJST1InLCAnTm90IGNvbm5lY3RpbmcnKVxuXHRcdH0gZWxzZSBpZiAoY29ubmVjdGVkID09PSAwKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdFUlJPUicsICdObyBjb25uZWN0aW9ucyBlc3RhYmxpc2hlZCcpXG5cdFx0fSBlbHNlIGlmIChjb25uZWN0ZWQgPCB3YW50cykge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnV0FSTklORycsIGBPbmx5ICR7Y29ubmVjdGVkfSBvZiAke3dhbnRzfSBjb25uZWN0aW9ucyBlc3RhYmxpc2hlZGApXG5cdFx0fSovXG5cdFx0aWYgKCF0aGlzLmNoZWNraW5nUmVnaW9ucyAmJiB3YW50cyA+IDAgJiYgY29ubmVjdGVkID09PSAwKSB7XG5cdFx0XHRpZiAodGhpcy5jb25uZWN0aW5nQ291bnRlcisrID4gMykge1xuXHRcdFx0XHRjb25zb2xlLmxvZyh0aGlzLmNoZWNraW5nUmVnaW9ucywgd2FudHMsIGNvbm5lY3RlZCk7XG5cdFx0XHRcdHRoaXMuc2V0U3RhdGUoJ0VSUk9SJywgJ05vIHJlbGV2YW50IHJlZ2lvbnMgYXJlIHJlYWNoYWJsZScpXG5cdFx0XHRcdHRoaXMuZW1pdCgnbG9nJywgJ2Vycm9yJywgJ05vIHJlbGV2YW50IHJlZ2lvbnMgYXJlIHJlYWNoYWJsZSwgY2hlY2sgeW91ciBpbnRlcm5ldCBjb25uZWN0aW9uJylcblx0XHRcdFx0dGhpcy5jb25uZWN0aW5nQ291bnRlciA9IDBcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBNYWtlIHN1cmUgd2UgdGVzdCB0aGUgY29ubmVjdGlvbnMgaW1tZWRpYXRlbHkgYWZ0ZXIgd2UgaGF2ZSBjb25uZWN0ZWQgdG8gYWxsIHJlZ2lvbnNcblx0XHQvLyB0byBnZXQgYSBmYXN0IG1haW4gc3RhdGUgdXBkYXRlXG5cdFx0aWYgKGNvbm5lY3RlZCA9PSB3YW50cykge1xuXHRcdFx0dGhpcy5waW5nQ29tcGFuaW9uKCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyB1cGRhdGVSZWdpb25zRnJvbVJFU1QoKSB7XG5cdFx0dGhpcy5jaGVja2luZ1JlZ2lvbnMgPSB0cnVlXG5cdFx0Y29uc3QgbmV3UmVnaW9ucyA9IGF3YWl0IHRoaXMuZmV0Y2hSZWdpb25zRm9yKHRoaXMuY29tcGFuaW9uSWQpXG5cdFx0dGhpcy5jaGVja2luZ1JlZ2lvbnMgPSBmYWxzZVxuXHRcdGlmIChuZXdSZWdpb25zLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhpcy5lbWl0KFxuXHRcdFx0XHQnbG9nJyxcblx0XHRcdFx0J2Vycm9yJyxcblx0XHRcdFx0J1JlbW90ZSBjb21wYW5pb24gZG9lcyBub3Qgc2VlbSB0byBiZSByZWdpc3RlcmVkIHdpdGggdGhlIGNsb3VkLCByZXRyeWluZyBpbiAxMCBzZWNvbmRzJ1xuXHRcdFx0KVxuXHRcdFx0aWYgKHRoaXMucmVnaW9ucy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdHRoaXMucmVnaW9ucyA9IG5ld1JlZ2lvbnNcblx0XHRcdFx0dGhpcy5yZWNhbGN1bGF0ZVJlZ2lvbnMoKVx0XHRcblx0XHRcdH1cblx0XHRcdHJldHVyblxuXHRcdH1cblx0XHR0aGlzLnJlZ2lvbnMgPSBuZXdSZWdpb25zXG5cdFx0dGhpcy5yZWNhbGN1bGF0ZVJlZ2lvbnMoKVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyByZWNhbGN1bGF0ZVJlZ2lvbnMoKSB7XG5cdFx0Y29uc3QgcmVnaW9uc1RvUmVtb3ZlID0gdGhpcy5jdXJyZW50UmVnaW9ucy5maWx0ZXIoKHIpID0+ICF0aGlzLnJlZ2lvbnMuZmluZCgobnIpID0+IG5yLmlkID09PSByLmlkKSlcblx0XHRjb25zdCByZWdpb25zVG9BZGQgPSB0aGlzLnJlZ2lvbnMuZmlsdGVyKChyKSA9PiAhdGhpcy5jdXJyZW50UmVnaW9ucy5maW5kKChucikgPT4gbnIuaWQgPT09IHIuaWQpKVxuXG5cdFx0Zm9yIChjb25zdCByZWdpb24gb2YgcmVnaW9uc1RvUmVtb3ZlKSB7XG5cdFx0XHRjb25zdCBjb25uZWN0aW9uID0gdGhpcy5jb25uZWN0aW9ucy5maW5kKChjKSA9PiBjLnJlZ2lvbklkID09PSByZWdpb24uaWQpXG5cdFx0XHRpZiAoY29ubmVjdGlvbikge1xuXHRcdFx0XHRhd2FpdCBjb25uZWN0aW9uLmRlc3Ryb3koKVxuXHRcdFx0XHR0aGlzLmNvbm5lY3Rpb25zID0gdGhpcy5jb25uZWN0aW9ucy5maWx0ZXIoKGMpID0+IGMucmVnaW9uSWQgIT09IHJlZ2lvbi5pZClcblx0XHRcdH1cblx0XHRcdHRoaXMuY3VycmVudFJlZ2lvbnMgPSB0aGlzLmN1cnJlbnRSZWdpb25zLmZpbHRlcigocikgPT4gci5pZCAhPT0gcmVnaW9uLmlkKVxuXHRcdFx0dGhpcy5lbWl0KCdsb2cnLCAnaW5mbycsIGBSZWdpb24gJHtyZWdpb24ubGFiZWx9IHJlbW92ZWRgKVxuXHRcdH1cblxuXHRcdGZvciAoY29uc3QgcmVnaW9uIG9mIHJlZ2lvbnNUb0FkZCkge1xuXHRcdFx0Y29uc3QgbmV3Q29ubmVjdGlvbiA9IG5ldyBDbG91ZENvbm5lY3Rpb24ocmVnaW9uLmlkLCByZWdpb24uaG9zdG5hbWUsIHRoaXMuY29tcGFuaW9uSWQpXG5cdFx0XHR0aGlzLmNvbm5lY3Rpb25zID0gWy4uLnRoaXMuY29ubmVjdGlvbnMsIG5ld0Nvbm5lY3Rpb25dXG5cdFx0XHR0aGlzLmN1cnJlbnRSZWdpb25zID0gWy4uLnRoaXMuY3VycmVudFJlZ2lvbnMsIHJlZ2lvbl1cblxuXHRcdFx0bmV3Q29ubmVjdGlvbi5vbignc29ja2V0c3RhdGUnLCAoc3RhdGUpID0+IHtcblx0XHRcdFx0Ly9jb25zb2xlLmxvZygnREVCVUc7IFJlZ2lvbiAlbyBjaGFuZ2VkIHN0YXRlIHRvICVvJywgcmVnaW9uLmlkLCBzdGF0ZSlcblx0XHRcdFx0dGhpcy5jYWxjdWxhdGVTdGF0ZSgpXG5cdFx0XHR9KVxuXG5cdFx0XHRuZXdDb25uZWN0aW9uLm9uKCdiYW5rcycsIChiYW5rcykgPT4ge1xuXHRcdFx0XHRpZiAodGhpcy51cGRhdGVJZHNbYmFua3MudXBkYXRlSWRdKSByZXR1cm5cblx0XHRcdFx0dGhpcy51cGRhdGVJZHNbYmFua3MudXBkYXRlSWRdID0gRGF0ZS5ub3coKVxuXHRcdFx0XHR0aGlzLmVtaXQoJ3VwZGF0ZUFsbCcsIGJhbmtzLmRhdGEgYXMgTXVsdGlCYW5rKVxuXHRcdFx0fSlcblxuXHRcdFx0bmV3Q29ubmVjdGlvbi5vbignYmFuaycsIChiYW5rKSA9PiB7XG5cdFx0XHRcdGlmICh0aGlzLnVwZGF0ZUlkc1tiYW5rLnVwZGF0ZUlkXSkgcmV0dXJuXG5cdFx0XHRcdHRoaXMuZW1pdCgndXBkYXRlJywgYmFuay5wYWdlLCBiYW5rLmJhbmssIGJhbmsuZGF0YSlcblx0XHRcdFx0dGhpcy51cGRhdGVJZHNbYmFuay51cGRhdGVJZF0gPSBEYXRlLm5vdygpXG5cdFx0XHR9KVxuXG5cdFx0XHRuZXdDb25uZWN0aW9uLm9uKCdyZWdpb25zJywgKHJlZ2lvbnMpID0+IHtcblx0XHRcdFx0Ly9jb25zb2xlLmxvZygnTmV3IHJlZ2lvbnM6ICcsIHJlZ2lvbnMpXG5cdFx0XHRcdC8vY29uc29sZS5sb2coJ09sZCByZWdpb25zOiAnLCB0aGlzLnJlZ2lvbnMpXG5cdFx0XHR9KVxuXG5cdFx0XHR2b2lkIG5ld0Nvbm5lY3Rpb24uaW5pdCgpXG5cdFx0XHR0aGlzLmVtaXQoJ2xvZycsICdpbmZvJywgYFJlZ2lvbiAke3JlZ2lvbi5sYWJlbH0gYWRkZWRgKVxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgZmV0Y2hSZWdpb25zRm9yKGNvbXBhbmlvbklkOiBzdHJpbmcpIHtcblx0XHQvL2lmICh0aGlzLmNvdW50ZXIrKyA8IDIpIHJldHVybiBbXVxuXHRcdHRyeSB7XG5cdFx0XHRyZXR1cm4gKGF3YWl0IHRoaXMuYXhpb3MuZ2V0KGAvaW5mcmFzdHJ1Y3R1cmUvY2xvdWQvcmVnaW9ucy9jb21wYW5pb24vJHtjb21wYW5pb25JZH1gKSkuZGF0YSBhcyB7XG5cdFx0XHRcdGlkOiBzdHJpbmdcblx0XHRcdFx0aG9zdG5hbWU6IHN0cmluZ1xuXHRcdFx0XHRsb2NhdGlvbjogc3RyaW5nXG5cdFx0XHRcdGxhYmVsOiBzdHJpbmdcblx0XHRcdH1bXVxuXHRcdH0gY2F0Y2ggKGUpIHtcblx0XHRcdHJldHVybiBbXVxuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBwaW5naW5nIGlzIHNlbnQgaW5kaXZpZHVhbGx5LCBhbmQgY291bnRlZCB1cCwgaW4gY29udHJhc3QgdG8gY2xpZW50Q29tbWFuZFxuXHQgKi9cblx0YXN5bmMgcGluZ0NvbXBhbmlvbigpIHtcblx0XHRjb25zdCBvbmxpbmVDb25uZWN0aW9ucyA9IHRoaXMuY29ubmVjdGlvbnMuZmlsdGVyKChjb25uZWN0aW9uKSA9PiBjb25uZWN0aW9uLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ0NPTk5FQ1RFRCcpXG5cblx0XHRjb25zdCBhbGxUaGVQcm9taXNlcyA9IG9ubGluZUNvbm5lY3Rpb25zLm1hcCgoY29ubmVjdGlvbikgPT4ge1xuXHRcdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdFx0Y29uc3QgY2FsbGVySWQgPSBnZW5lcmF0ZVJhbmRvbVVVSUQoKVxuXHRcdFx0XHRjb25zdCByZXBseUNoYW5uZWwgPSAnY29tcGFuaW9uUHJvY1Jlc3VsdDonICsgY2FsbGVySWRcblxuXHRcdFx0XHRjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0Y29ubmVjdGlvbi5zb2NrZXQ/LnVuc3Vic2NyaWJlKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHRjb25uZWN0aW9uLnNvY2tldD8uY2xvc2VDaGFubmVsKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHRyZWplY3QobmV3IEVycm9yKCdUaW1lb3V0JykpXG5cdFx0XHRcdH0sIENPTVBBTklPTl9QSU5HX1RJTUVPVVQpXG5cblx0XHRcdFx0Oyhhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0Zm9yIGF3YWl0IChsZXQgZGF0YSBvZiBjb25uZWN0aW9uLnNvY2tldC5zdWJzY3JpYmUocmVwbHlDaGFubmVsKSkge1xuXHRcdFx0XHRcdFx0Ly9jb25zb2xlLmxvZygnREVCVUc6IEdvdCByZXBseSBmcm9tIGNvbXBhbmlvbicsIGRhdGEpXG5cdFx0XHRcdFx0XHRjb25uZWN0aW9uLnNvY2tldD8udW5zdWJzY3JpYmUocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdFx0Y29ubmVjdGlvbi5zb2NrZXQ/LmNsb3NlQ2hhbm5lbChyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZW91dClcblx0XHRcdFx0XHRcdHJlc29sdmUodHJ1ZSlcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0pKClcblxuXHRcdFx0XHRjb25uZWN0aW9uLnNvY2tldD8udHJhbnNtaXRQdWJsaXNoPy4oYGNvbXBhbmlvblByb2M6JHt0aGlzLmNvbXBhbmlvbklkfTpwaW5nYCwgeyBhcmdzOiBbXSwgY2FsbGVySWQgfSlcblx0XHRcdH0pXG5cdFx0fSlcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChhbGxUaGVQcm9taXNlcylcblx0XHRjb25zdCBzdWNjZXNzID0gcmVzdWx0LmZpbHRlcigocikgPT4gci5zdGF0dXMgPT09ICdmdWxmaWxsZWQnKS5sZW5ndGhcblx0XHRjb25zdCBmYWlsZWQgPSByZXN1bHQuZmlsdGVyKChyKSA9PiByLnN0YXR1cyA9PT0gJ3JlamVjdGVkJykubGVuZ3RoXG5cblx0XHRpZiAoc3VjY2VzcyA9PT0gMCAmJiB0aGlzLnJlZ2lvbnMubGVuZ3RoID4gMCkge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnRVJST1InLCAnUmVtb3RlIGNvbXBhbmlvbiBpcyB1bnJlYWNoYWJsZScpXG5cdFx0XHR0aGlzLmVtaXQoXG5cdFx0XHRcdCdsb2cnLFxuXHRcdFx0XHQnZXJyb3InLFxuXHRcdFx0XHRgUmVtb3RlIGNvbXBhbmlvbiBpcyB1bnJlYWNoYWJsZSB2aWEgaXRzICR7dGhpcy5yZWdpb25zLmxlbmd0aH0gcmVnaW9uIGNvbm5lY3Rpb24ke1xuXHRcdFx0XHRcdHRoaXMucmVnaW9ucy5sZW5ndGggIT09IDEgPyAncycgOiAnJ1xuXHRcdFx0XHR9YFxuXHRcdFx0KVxuXHRcdH0gZWxzZSBpZiAoZmFpbGVkID4gMCkge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnV0FSTklORycsIGBSZW1vdGUgY29tcGFuaW9uIGlzIHVucmVhY2hhYmxlIHRocm91Z2ggc29tZSByZWdpb25zYClcblx0XHRcdHRoaXMuZW1pdChcblx0XHRcdFx0J2xvZycsXG5cdFx0XHRcdCd3YXJuaW5nJyxcblx0XHRcdFx0YFJlbW90ZSBjb21wYW5pb24gaXMgb25seSByZWFjaGFibGUgb24gJHtzdWNjZXNzfSBvZiAke29ubGluZUNvbm5lY3Rpb25zLmxlbmd0aH0gcmVnaW9uc2Bcblx0XHRcdClcblx0XHR9IGVsc2UgaWYgKHN1Y2Nlc3MgPT09IG9ubGluZUNvbm5lY3Rpb25zLmxlbmd0aCAmJiBvbmxpbmVDb25uZWN0aW9ucy5sZW5ndGggPiAwKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdPSycpXG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgY2xpZW50Q29tbWFuZChuYW1lOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKSB7XG5cdFx0Y29uc3QgY2FsbGVySWQgPSBnZW5lcmF0ZVJhbmRvbVVVSUQoKVxuXHRcdGNvbnN0IHJlcGx5Q2hhbm5lbCA9ICdjb21wYW5pb25Qcm9jUmVzdWx0OicgKyBjYWxsZXJJZFxuXG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdHRoaXMuY29ubmVjdGlvbnNcblx0XHRcdFx0XHQuZmlsdGVyKChjb25uZWN0aW9uKSA9PiBjb25uZWN0aW9uLmNvbm5lY3Rpb25TdGF0ZSA9PT0gJ0NPTk5FQ1RFRCcpXG5cdFx0XHRcdFx0LmZvckVhY2goKGNvbm5lY3Rpb24pID0+IHtcblx0XHRcdFx0XHRcdGNvbm5lY3Rpb24uc29ja2V0Py51bnN1YnNjcmliZShyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0XHRjb25uZWN0aW9uLnNvY2tldD8uY2xvc2VDaGFubmVsKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHR9KVxuXHRcdFx0XHRyZWplY3QobmV3IEVycm9yKCdDbGllbnRDb21tYW5kIHRpbWVvdXQnKSlcblx0XHRcdH0sIDEwMDAwKVxuXG5cdFx0XHRsZXQgaXNIYW5kZWxlZCA9IGZhbHNlXG5cdFx0XHR0aGlzLmNvbm5lY3Rpb25zXG5cdFx0XHRcdC5maWx0ZXIoKGNvbm5lY3Rpb24pID0+IGNvbm5lY3Rpb24uY29ubmVjdGlvblN0YXRlID09PSAnQ09OTkVDVEVEJylcblx0XHRcdFx0LmZvckVhY2goKGNvbm5lY3Rpb24pID0+IHtcblx0XHRcdFx0XHRjb25zdCBzb2NrZXQgPSBjb25uZWN0aW9uLnNvY2tldFxuXHRcdFx0XHRcdDsoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdFx0Zm9yIGF3YWl0IChsZXQgZGF0YSBvZiBzb2NrZXQ/LnN1YnNjcmliZShyZXBseUNoYW5uZWwpKSB7XG5cdFx0XHRcdFx0XHRcdGlmIChpc0hhbmRlbGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0c29ja2V0Py51bnN1YnNjcmliZShyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0XHRcdFx0c29ja2V0Py5jbG9zZUNoYW5uZWwocmVwbHlDaGFubmVsKVxuXHRcdFx0XHRcdFx0XHRcdHJldHVyblxuXHRcdFx0XHRcdFx0XHR9XG5cbi8vXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZygnREVCVUc7IEdvdCByZXNwb25zZSBmb3IgY29tbWFuZCAlbycsIHRoaXMuY29tcGFuaW9uSWQgKyAnOicgKyBuYW1lKVxuXHRcdFx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZXIpXG5cdFx0XHRcdFx0XHRcdGlzSGFuZGVsZWQgPSB0cnVlXG5cblx0XHRcdFx0XHRcdFx0aWYgKGRhdGEuZXJyb3IpIHtcblx0XHRcdFx0XHRcdFx0XHRyZWplY3QobmV3IEVycm9yKCdycGMgZXJyb3I6ICcgKyBkYXRhLmVycm9yKSlcblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRyZXNvbHZlKGRhdGEucmVzdWx0KVxuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0c29ja2V0Py51bnN1YnNjcmliZShyZXBseUNoYW5uZWwpXG5cdFx0XHRcdFx0XHRcdHNvY2tldD8uY2xvc2VDaGFubmVsKHJlcGx5Q2hhbm5lbClcblx0XHRcdFx0XHRcdFx0YnJlYWtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9KSgpXG4vKlxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKFxuXHRcdFx0XHRcdFx0J0RFQlVHOyBTZW5kaW5nIGNvbW1hbmQgdG8gJW86ICVvJyxcblx0XHRcdFx0XHRcdGNvbm5lY3Rpb24ucmVnaW9uSWQsXG5cdFx0XHRcdFx0XHRgY29tcGFuaW9uUHJvYzoke3RoaXMuY29tcGFuaW9uSWR9OiR7bmFtZX1gXG5cdFx0XHRcdFx0KSovXG5cdFx0XHRcdFx0c29ja2V0Py50cmFuc21pdFB1Ymxpc2goYGNvbXBhbmlvblByb2M6JHt0aGlzLmNvbXBhbmlvbklkfToke25hbWV9YCwgeyBhcmdzLCBjYWxsZXJJZCB9KVxuXHRcdFx0XHR9KVxuXHRcdH0pXG5cdH1cblxuXHQvKipcblx0ICogSW5pdGlhbGl6ZXMgdGhlIGNvbm5lY3Rpb24gdG8gdGhlIGNsb3VkXG5cdCAqL1xuXHRhc3luYyBpbml0KCkge1xuXHRcdHRoaXMucGluZ1RpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0dGhpcy5waW5nQ29tcGFuaW9uKClcblxuXHRcdFx0Ly8gQ2xlYW51cCB1cGRhdGUgaWRzXG5cdFx0XHRmb3IgKGxldCBrZXkgaW4gdGhpcy51cGRhdGVJZHMpIHtcblx0XHRcdFx0aWYgKERhdGUubm93KCkgLSB0aGlzLnVwZGF0ZUlkc1trZXldID49IDMwMDAwKSB7XG5cdFx0XHRcdFx0ZGVsZXRlIHRoaXMudXBkYXRlSWRzW2tleV1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0sIENPTVBBTklPTl9QSU5HX1RJTUVPVVQgKyAyMDAwKVxuXG5cdFx0dGhpcy5zZXRTdGF0ZSgnV0FSTklORycsICdDb25uZWN0aW5nIHRvIGNsb3VkJylcblx0XHR0aGlzLmNoZWNrQ29ubmVjdGlvblRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0dGhpcy51cGRhdGVSZWdpb25zRnJvbVJFU1QoKVxuXHRcdH0sIDEwMDAwKTtcblxuXHRcdGF3YWl0IHRoaXMudXBkYXRlUmVnaW9uc0Zyb21SRVNUKClcblx0fVxuXG5cdC8qKlxuXHQgKiBEZXN0cm95cyBydW5uaW5nIHRpbWVycyBhbmQgY29ubmVjdGlvbnNcblx0ICovXG5cdGRlc3Ryb3koKSB7XG5cdFx0aWYgKHRoaXMucGluZ1RpbWVyKSB7XG5cdFx0XHRjbGVhckludGVydmFsKHRoaXMucGluZ1RpbWVyKVxuXHRcdH1cblx0XHRpZiAodGhpcy5jaGVja0Nvbm5lY3Rpb25UaW1lcikge1xuXHRcdFx0Y2xlYXJJbnRlcnZhbCh0aGlzLmNoZWNrQ29ubmVjdGlvblRpbWVyKVxuXHRcdH1cblx0XHR0aGlzLmNvbm5lY3Rpb25zLmZvckVhY2goKGNvbm5lY3Rpb24pID0+IHtcblx0XHRcdGNvbm5lY3Rpb24uZGVzdHJveSgpXG5cdFx0fSlcblx0XHR0aGlzLmNvbm5lY3Rpb25zID0gW11cblx0XHR0aGlzLnJlZ2lvbnMgPSBbXVxuXHR9XG5cblx0Y29ubmVjdCgpIHt9XG59XG4iXX0=