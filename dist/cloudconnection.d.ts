import { AGClientSocket } from 'socketcluster-client';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from './events';
import { SingleBank, MultiBank } from './types';
export declare type SocketStates = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
declare type RegionDetails = {
    id: string;
    host: string;
};
interface CloudConnectionEvents {
    socketstate: (state: SocketStates) => void;
    error: (error: Error) => void;
    bank: (bank: SingleBank & {
        updateId: string;
    }) => void;
    banks: (banks: {
        updateId: string;
        data: MultiBank;
    }) => void;
    regions: (regions: RegionDetails[]) => void;
}
declare const CloudConnection_base: new () => StrictEventEmitter<EventEmitter, CloudConnectionEvents>;
export declare class CloudConnection extends CloudConnection_base {
    private companionId;
    private hostname;
    private alive;
    socket: AGClientSocket;
    connectionState: SocketStates;
    regionId: string;
    constructor(regionId: string, hostname: string, companionId: string);
    /**
     * Initializes the connection to the cloud
     */
    init(): Promise<void>;
    initHandlers(): void;
    /**
     * Destroys this object and disconnects from the cloud
     *
     * NB: Never use this object again after calling this method
     */
    destroy(): Promise<void>;
}
export {};
