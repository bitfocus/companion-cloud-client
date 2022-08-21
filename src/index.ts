import { CloudConnection } from './cloudconnection'
import axios from 'axios'
import StrictEventEmitter from 'strict-event-emitter-types'
import { EventEmitter } from 'events'
import * as crypto from 'crypto'

const CLOUD_URL =
	process.env.NODE_ENV === 'production' ? 'https://api.bitfocus.io/v1' : 'https://api-staging.bitfocus.io/v1'

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
		this.moduleState = state
		this.emit('state', state, message)
	}

	private calculateState() {
		const connected = this.connections.filter((c) => c.connectionState === 'CONNECTED').length
		const connecting = this.connections.filter((c) => c.connectionState === 'CONNECTING').length
		//const disconnected = this.connections.filter(c => c.connectionState === 'DISCONNECTED').length;
		const wants = this.regions.length

		if (connected >= wants) {
			this.setState('OK') // TODO: only if remote companion is also OK
		} else if (connected + connecting === 0) {
			this.setState('ERROR', 'Not connecting')
		} else if (connected === 0) {
			this.setState('ERROR', 'No connections established')
		} else if (connected < wants) {
			this.setState('WARNING', `Only ${connected} of ${wants} connections established`)
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
					hostname: 'no-oslo-cloud1-staging.bitfocus.io',
					location: 'NO',
					label: 'Norway',
				},
				{
					id: 'eu-north-no2',
					hostname: 'no-oslo-cloud1-staging.bitfocus.io',
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

	async clientCommand(name: string, ...args: any[]) {
		const callerId = crypto.randomUUID()
		const replyChannel = 'companionProcResult:' + callerId

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error('ClientCommand timeout'))
				this.connections
					.filter((connection) => connection.connectionState === 'CONNECTED')
					.forEach((connection) => {
						connection.socket.unsubscribe(replyChannel)
						connection.socket.closeChannel(replyChannel)
					})
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
		await this.updateRegionsFromREST()
	}

	connect() {}
}

const test = new CloudClient('111-222-333-444')

test.on('state', (state, message) => {
	console.log({ state, message })

	if (state === 'OK') {
		test.clientCommand('refresh').then(console.log).catch(console.error)
	}
})

test.on('log', (level, message) => {
	console.log({ level, message })
})

test.init()
