import { AGClientSocket, create as createSocket } from 'socketcluster-client';

export class CloudConnection {
    private socket: AGClientSocket;

    constructor() {
        this.socket = createSocket({
            hostname: 'localhost',
            //port: region.hostname.match(/^127\./) ? '443,
            secure: false,
            autoReconnectOptions: {
                initialDelay: 1000, //milliseconds
                randomness: 2000, //milliseconds
                multiplier: 1.5, //decimal
                maxDelay: 10000, //milliseconds
            },
        });
    }
}