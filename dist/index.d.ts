import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from './events';
import { CompanionButtonStyleProps } from './types';
export declare type RegionDefinition = {
    id: string;
    hostname: string;
    location: string;
    label: string;
};
export declare type CCModuleState = 'IDLE' | 'WARNING' | 'ERROR' | 'OK';
export declare type CCLogLevel = 'error' | 'warning' | 'info' | 'debug';
interface CloudClientEvents {
    state: (state: CCModuleState, message?: string) => void;
    error: (error: Error) => void;
    log: (level: CCLogLevel, message: string) => void;
    update: (page: number, bank: number, data: CompanionButtonStyleProps) => void;
    updateAll: (banks: {
        page: number;
        bank: number;
        data: CompanionButtonStyleProps;
    }[]) => void;
}
declare const CloudClient_base: new () => StrictEventEmitter<EventEmitter, CloudClientEvents>;
/**
 * The CloudClient is responsible for connecting to the cloud and
 * communicating with the companion server
 */
export declare class CloudClient extends CloudClient_base {
    private companionId;
    private connections;
    private currentRegions;
    private regions;
    private axios;
    private counter;
    private connectingCounter;
    private moduleState;
    private checkingRegions;
    private pingTimer;
    private checkConnectionTimer;
    private updateIds;
    /**
     * Creates a new CloudClient
     *
     * @param remoteCompanionId The super secret id to connect to via the cloud
     */
    constructor(remoteCompanionId: string);
    private setState;
    private calculateState;
    private updateRegionsFromREST;
    private recalculateRegions;
    private fetchRegionsFor;
    /**
     * pinging is sent individually, and counted up, in contrast to clientCommand
     */
    pingCompanion(): Promise<void>;
    clientCommand(name: string, ...args: any[]): Promise<unknown>;
    /**
     * Initializes the connection to the cloud
     */
    init(): Promise<void>;
    /**
     * Destroys running timers and connections
     */
    destroy(): void;
    connect(): void;
}
export {};
