import { AGClientSocket, create as createSocket } from 'socketcluster-client';

export class CloudConnection {
    private socket: AGClientSocket;
    private companionId: string;
    
    public regionId: string;

    constructor(regionId: string, hostname: string, companionId: string) {
        this.regionId = regionId;
        this.companionId = companionId;

        this.socket = createSocket({
            hostname,
            //port: region.hostname.match(/^127\./) ? '443,
            secure: true,
            autoReconnectOptions: {
                initialDelay: 1000, //milliseconds
                randomness: 2000, //milliseconds
                multiplier: 1.5, //decimal
                maxDelay: 10000, //milliseconds
            },
        });
        this.socket.connect();
    }

    async init() {
        for await (const event of (this.socket?.listener('connect'))||[]) {
            console.log("Connected " + this.socket?.id);
        }
    }

    async remove() {
        this.socket.disconnect();

        // sorry, I don't want to have socket as a optional property
        let thes = this as any;
        delete thes.socket;
    }
}