import { CloudConnection } from "./cloudconnection";
import axios from 'axios'
import EventEmitter = require("events");

const CLOUD_URL = process.env.NODE_ENV === 'production' ? 'https://api.bitfocus.io/v1' : 'https://api-staging.bitfocus.io/v1'

export type RegionDefinition = {
    hostname: string;
    port: number;
    secure: boolean;
    label: string;
}
class RegionFetchException extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RegionFetchException";
    }
}

export class CloudClient extends EventEmitter {
    private companionId: string;
    private connections: CloudConnection[] = [];
    private currentRegions: RegionDefinition[] = [];
    private axios = axios.create({
        baseURL: CLOUD_URL,
        timeout: 10000
    });
    
    constructor(remoteCompanionId: string) {
        super();
        this.companionId = remoteCompanionId;
    }

    async init() {
        const regions = this.fetchRegionsFor(this.companionId);
    }

    async fetchRegionsFor(companionId: string) {
        try {
            return (await this.axios.get(`/infrastructure/companion/${companionId}`)).data.cloud?.regions as {
                id: string;
                hostname: string;
                location: string;
                label: string;
            }[];
        } catch (e) {
            this.emit('error', new RegionFetchException((e as Error).message))
            return [];
        }
    }

    connect() {
        this.connections.push(new CloudConnection());
    }
}

const test = new CloudClient('test');
test.fetchRegions().then(() => { console.log("done"); });