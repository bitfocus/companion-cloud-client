import { CloudConnection } from './cloudconnection'
import axios from 'axios'
import StrictEventEmitter from 'strict-event-emitter-types'
import { EventEmitter } from 'events'
import * as crypto from 'crypto'

const CLOUD_URL =
	process.env.NODE_ENV === 'production' ? 'https://api.bitfocus.io/v1' : 'https://api-staging.bitfocus.io/v1'

const COMPANION_PING_TIMEOUT = 5000;

export type RegionDefinition = {
	id: string
	hostname: string
	location: string
	label: string
}

class RegionFetchException extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'RegionFetchException'
	}
}

export type ModuleState = 'IDLE' | 'WARNING' | 'ERROR' | 'OK'
interface CloudClientEvents {
	state: (state: ModuleState, message?: string) => void
	error: (error: Error) => void
	log: (level: string, message: string) => void
}

/**
 * The CloudClient is responsible for connecting to the cloud and
 * communicating with the companion server
 */
export class CloudClient extends (EventEmitter as { new (): StrictEventEmitter<EventEmitter, CloudClientEvents> }) {
	private companionId: string
	private connections: CloudConnection[] = []
	private currentRegions: RegionDefinition[] = []
	private regions: RegionDefinition[] = []
	private axios = axios.create({
		baseURL: CLOUD_URL,
		timeout: 10000,
	})
	private counter = 0
	private moduleState: ModuleState = 'IDLE'
	private pingTimer: NodeJS.Timer | undefined
	private updateIds: { [key: string]: number } = {}

	/**
	 * Creates a new CloudClient
	 *
	 * @param remoteCompanionId The super secret id to connect to via the cloud
	 */
	constructor(remoteCompanionId: string) {
		super()
		this.companionId = remoteCompanionId
	}

	private setState(state: ModuleState, message?: string) {
		if (state !== this.moduleState) {
			this.moduleState = state
			this.emit('state', state, message)
		}
	}

	private calculateState() {
		const connected = this.connections.filter((c) => c.connectionState === 'CONNECTED').length
		const connecting = this.connections.filter((c) => c.connectionState === 'CONNECTING').length
		//const disconnected = this.connections.filter(c => c.connectionState === 'DISCONNECTED').length;
		const wants = this.regions.length

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
			this.setState('ERROR', 'No relevant regions are reachable')
			this.emit('log', 'error', 'No relevant regions are reachable, check your internet connection')
		}
	}

	private async updateRegionsFromREST() {
		const newRegions = await this.fetchRegionsFor(this.companionId)
		if (newRegions.length === 0) {
			this.emit(
				'log',
				'error',
				'Remote companion does not seem to be registered with the cloud, retrying in 10 seconds'
			)
			setTimeout(() => this.updateRegionsFromREST(), 10000)
			return
		}
		this.regions = newRegions
		this.recalculateRegions()
	}

	private async recalculateRegions() {
		const regionsToRemove = this.currentRegions.filter((r) => !this.regions.find((nr) => nr.id === r.id))
		const regionsToAdd = this.regions.filter((r) => !this.currentRegions.find((nr) => nr.id === r.id))

		for (const region of regionsToRemove) {
			const connection = this.connections.find((c) => c.regionId === region.id)
			if (connection) {
				await connection.destroy()
				this.connections = this.connections.filter((c) => c.regionId !== region.id)
			}
			this.currentRegions = this.currentRegions.filter((r) => r.id !== region.id)
			this.emit('log', 'info', `Region ${region.label} removed`)
		}

		for (const region of regionsToAdd) {
			const newConnection = new CloudConnection(region.id, region.hostname, this.companionId)
			this.connections = [...this.connections, newConnection]
			this.currentRegions = [...this.currentRegions, region]

			newConnection.on('socketstate', (state) => {
				console.log('DEBUG; Region %o changed state to %o', region.id, state)
				this.calculateState()
			})
			
			newConnection.on('banks', (banks) => {
				if (this.updateIds[banks.updateId]) return;
				console.log("All the banks: ", banks);
				this.updateIds[banks.updateId] = Date.now();
			});

			newConnection.on('bank', (bank) => {
				if (this.updateIds[bank.updateId]) return;
				console.log("bank:", bank.data.text)
				this.updateIds[bank.updateId] = Date.now();
			});

			void newConnection.init()
			this.emit('log', 'info', `Region ${region.label} added`)
		}
	}

	private async fetchRegionsFor(companionId: string) {
		if (this.counter++ === 1) {
			return []
		}
		try {
			return [
				{
					id: 'eu-north-no1',
					hostname: 'no-oslo-cloud1.bitfocus.io',
					location: 'NO',
					label: 'Norway',
				},
				{
					id: 'eu-north-no2',
					hostname: 'no-oslo-cloud1.bitfocus.io',
					location: 'NO',
					label: 'Norway 2',
				},
			]
			return (await this.axios.get(`/infrastructure/companion/${companionId}/regions`)).data as {
				id: string
				hostname: string
				location: string
				label: string
			}[]
		} catch (e) {
			return []
		}
	}

	/**
	 * pinging is sent individually, and counted up, in contrast to clientCommand
	 */
	async pingCompanion() {
		const onlineConnections = this.connections
		.filter((connection) => connection.connectionState === 'CONNECTED');
	
		const allThePromises = onlineConnections.map((connection) => {
			return new Promise((resolve, reject) => {
				const callerId = crypto.randomUUID()
				const replyChannel = 'companionProcResult:' + callerId
		
				const timeout = setTimeout(() => {
					connection.socket.unsubscribe(replyChannel)
					connection.socket.closeChannel(replyChannel)
					reject(new Error('Timeout'))
				}, COMPANION_PING_TIMEOUT);

				(async () => {
					for await (let data of connection.socket.subscribe(replyChannel)) {
						console.log('DEBUG: Got reply from companion', data)
						connection.socket.unsubscribe(replyChannel)
						connection.socket.closeChannel(replyChannel)
						clearTimeout(timeout)
						resolve(true)
					}
				})();

				connection.socket.transmitPublish(`companionProc:${this.companionId}:ping`, { args: [], callerId })
			})
		});

		const result = await Promise.allSettled(allThePromises);
		const success = result.filter((r) => r.status === 'fulfilled').length;
		const failed = result.filter((r) => r.status === 'rejected').length;

		if (success === 0) {
			this.setState("ERROR", "Remote companion is unreachable");
			this.emit('log', 'error', `Remote companion is unreachable via its ${onlineConnections.length} region connection${onlineConnections.length !== 1 ? 's' : ''}`);
		} else if (failed > 0) {
			this.setState("WARNING", `Remote companion is unreachable through some regions`);
			this.emit('log', 'warning', `Remote companion is only reachable on ${success} of ${onlineConnections.length} regions`);
		} else if (success === onlineConnections.length) {
			this.setState("OK");
		}
	}

	async clientCommand(name: string, ...args: any[]) {
		const callerId = crypto.randomUUID()
		const replyChannel = 'companionProcResult:' + callerId

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.connections
					.filter((connection) => connection.connectionState === 'CONNECTED')
					.forEach((connection) => {
						connection.socket.unsubscribe(replyChannel)
						connection.socket.closeChannel(replyChannel)
					})
				reject(new Error('ClientCommand timeout'))
			}, 10000)

			let isHandeled = false
			this.connections
				.filter((connection) => connection.connectionState === 'CONNECTED')
				.forEach((connection) => {
					const socket = connection.socket
					;(async () => {
						for await (let data of socket.subscribe(replyChannel)) {
							if (isHandeled) {
								socket.unsubscribe(replyChannel)
								socket.closeChannel(replyChannel)
								return
							}

							console.log('DEBUG; Got response for command %o', this.companionId + ':' + name)
							clearTimeout(timer)
							isHandeled = true

							if (data.error) {
								reject(new Error('rpc error: ' + data.error))
							} else {
								resolve(data.result)
							}

							socket.unsubscribe(replyChannel)
							socket.closeChannel(replyChannel)
							break
						}
					})()

					console.log(
						'DEBUG; Sending command to %o: %o',
						connection.regionId,
						`companionProc:${this.companionId}:${name}`
					)
					socket.transmitPublish(`companionProc:${this.companionId}:${name}`, { args, callerId })
				})
		})
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
					delete this.updateIds[key]
				}
			}
		}, COMPANION_PING_TIMEOUT + 2000);

		await this.updateRegionsFromREST()
	}

	/**
	 * Destroys running timers and connections
	 */
	destroy() {
		if (this.pingTimer) {
			clearInterval(this.pingTimer)
		}
		this.connections.forEach((connection) => {
			connection.destroy()
		})
		this.connections = []
		this.regions = []
	}

	connect() {}
}

const test = new CloudClient('d84d2efe-8943-580c-8a8e-c98742043fa9')

test.on('state', (state, message) => {
	console.log({ state, message })

	if (state === 'OK') {
		test.clientCommand('refresh').then(console.log).catch((err) => console.error("Handeled err:", err))
	}
})

test.on('log', (level, message) => {
	console.log({ level, message })
})

test.init()
