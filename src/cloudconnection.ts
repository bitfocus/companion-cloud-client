import { AGClientSocket, create as createSocket } from 'socketcluster-client';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
export type SocketStates = "DISCONNECTED" | "CONNECTING" | "CONNECTED";

interface CloudConnectionEvents {
    'socketstate': (state: SocketStates) => void;
    'error': (error: Error) => void;
}

export class CloudConnection extends (EventEmitter as { new(): StrictEventEmitter<EventEmitter, CloudConnectionEvents> }) {
    private socket: AGClientSocket;
    private companionId: string;
    private hostname: string;

    public connectionState: SocketStates = "DISCONNECTED";    
    public regionId: string;

    constructor(regionId: string, hostname: string, companionId: string) {
        super();
        this.regionId = regionId;
        this.hostname = hostname;
        this.companionId = companionId;
    }

    /**
     * Initializes the connection to the cloud
     */
    async init() {
        this.socket = createSocket({
            hostname: this.hostname,
            //port: region.hostname.match(/^127\./) ? '443,
            secure: true,
            autoReconnectOptions: {
                initialDelay: 1000, //milliseconds
                randomness: 2000, //milliseconds
                multiplier: 1.5, //decimal
                maxDelay: 10000, //milliseconds
            },
        });

        this.connectionState = "CONNECTING";
        this.emit('socketstate', this.connectionState);
        this.socket.connect();

        (async () => {
            for await (const event of (this.socket?.listener('connect'))||[]) {
                console.log("Connected " + this.socket?.id);
                this.connectionState = "CONNECTED";
                this.emit('socketstate', this.connectionState);
            }
        })();
    }

    initHandlers() {
        (async () => {
            for await (const event of (this.socket?.listener('disconnect'))||[]) {
                console.log("Disconnected " + this.socket?.id);
                this.connectionState = "DISCONNECTED";
                this.emit('socketstate', this.connectionState);
            }
        })();
    }

    /**
     * Destroys this object and disconnects from the cloud
     * 
     * NB: Never use this object again after calling this method
     */
    async destroy() {
        this.socket.disconnect();

        // sorry, I don't want to have socket as a optional property
        // this.socket will only be undefined after it should be deleted/garbage collected
        let thes = this as any;
        delete thes.socket;
    }
}