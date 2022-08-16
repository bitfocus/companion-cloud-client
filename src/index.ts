import { CloudConnection } from "./cloudconnection";
import axios from 'axios'
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';

const CLOUD_URL = process.env.NODE_ENV === 'production' ? 'https://api.bitfocus.io/v1' : 'https://api-staging.bitfocus.io/v1'

export type RegionDefinition = {
    id: string;
    hostname: string;
    location: string;
    label: string;
}

class RegionFetchException extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RegionFetchException";
    }
}

export type ModuleState = "IDLE" | "WARNING" | "ERROR" | "OK";
interface CloudClientEvents {
    'state': (state: ModuleState, message?: string) => void;
    'error': (error: Error) => void;
    'log': (level: string, message: string) => void;
}

export class CloudClient extends (EventEmitter as { new(): StrictEventEmitter<EventEmitter, CloudClientEvents> }) {
    private companionId: string;
    private connections: CloudConnection[] = [];
    private currentRegions: RegionDefinition[] = [];
    private regions: RegionDefinition[] = [];
    private axios = axios.create({
        baseURL: CLOUD_URL,
        timeout: 10000
    });
    private counter = 0;
    private moduleState: ModuleState = "IDLE";
    
    constructor(remoteCompanionId: string) {
        super();
        this.companionId = remoteCompanionId;
    }

    private setState(state: ModuleState, message?: string) {
        this.moduleState = state;
        this.emit('state', state, message);
    }

    private async recalculateRegions() {
        const newRegions = await this.fetchRegionsFor(this.companionId);
        if (newRegions.length === 0) {
            this.emit('log', 'error', 'Remote companion does not seem to be registered with the cloud, retrying in 10 seconds');
            setTimeout(() => this.recalculateRegions(), 10000);
        }
        this.regions = newRegions;
        const regionsToRemove = this.currentRegions.filter(r => !newRegions.find(nr => nr.id === r.id));
        const regionsToAdd = newRegions.filter(r => !this.currentRegions.find(nr => nr.id === r.id));

        for (const region of regionsToRemove) {
            const connection = this.connections.find(c => c.regionId === region.id);
            if (connection) {
                await connection.remove();
                this.connections = this.connections.filter(c => c.regionId !== region.id);
            }
            this.currentRegions = this.currentRegions.filter(r => r.id !== region.id);
            this.emit('log', 'info', `Region ${region.label} removed`);
        }

        for (const region of regionsToAdd) {
            this.connections.push(new CloudConnection(region.id, region.hostname, this.companionId));
            this.currentRegions.push(region);

            void this.connections[this.connections.length - 1].init();
            this.emit('log', 'info', `Region ${region.label} added`);
        }
    }

    async init() {
        await this.recalculateRegions();
    }

    async fetchRegionsFor(companionId: string) {
        if (this.counter++ === 1) {
            return [];
        }
        try {
            return (await this.axios.get(`/infrastructure/companion/${companionId}/regions`)).data as {
                id: string;
                hostname: string;
                location: string;
                label: string;
            }[];
        } catch (e) {
            return [];
        }
    }

    connect() {
    }
}

const test = new CloudClient('test');
test.on("state", (state, message) => {
    console.log({state, message});
});
test.on("log", (level, message) => {
    console.log({level, message});
});
test.init().then(() => {
    console.log("done1");
    test.init().then(() => {
        console.log("done2");
    });
});