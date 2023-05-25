import { AGClientSocket, create as createSocket } from 'socketcluster-client'
import StrictEventEmitter from 'strict-event-emitter-types'
import { EventEmitter } from './events'
import { SingleBank, MultiBank } from './types'
export type SocketStates = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'

let str_LOCAL_CLOUD_PORT = process.env.LOCAL_CLOUD_PORT || process.env.REACT_LOCAL_CLOUD_PORT
const LOCAL_CLOUD_PORT = str_LOCAL_CLOUD_PORT !== undefined ? parseInt(str_LOCAL_CLOUD_PORT) : 8000

type RegionDetails = {
	id: string
	host: string
}

interface CloudConnectionEvents {
	socketstate: (state: SocketStates) => void
	error: (error: Error) => void
	bank: (bank: SingleBank & { updateId: string }) => void
	banks: (banks: { updateId: string; data: MultiBank }) => void
	regions: (regions: RegionDetails[]) => void
}

export class CloudConnection extends (EventEmitter as {
	new (): StrictEventEmitter<EventEmitter, CloudConnectionEvents>
}) {
	private companionId: string
	private hostname: string
	private alive: boolean

	public socket: AGClientSocket
	public connectionState: SocketStates = 'DISCONNECTED'
	public regionId: string

	constructor(regionId: string, hostname: string, companionId: string) {
		super()
		this.regionId = regionId
		this.hostname = hostname
		this.companionId = companionId
	}

	/**
	 * Initializes the connection to the cloud
	 */
	async init() {
		this.alive = true
		this.socket = createSocket({
			hostname: this.hostname,
			port: !this.hostname.match(/^(127\.|localhost)/) ? 443 : LOCAL_CLOUD_PORT,
			secure: !this.hostname.match(/^(127\.|localhost)/),
			autoReconnectOptions: {
				initialDelay: 1000, //milliseconds
				randomness: 2000, //milliseconds
				multiplier: 1.5, //decimal
				maxDelay: 10000, //milliseconds
			},
		})

		this.connectionState = 'CONNECTING'
		this.emit('socketstate', this.connectionState)
		this.socket.connect()
		this.initHandlers()
	}

	initHandlers() {
		;(async () => {
			while (this.alive) {
				for await (const event of this.socket?.listener('connect') || []) {
					this.connectionState = 'CONNECTED'
					this.emit('socketstate', this.connectionState)
				}
			}
		})()
		;(async () => {
			while (this.alive) {
				for await (const event of this.socket?.listener('disconnect') || []) {
					this.connectionState = 'DISCONNECTED'
					this.emit('socketstate', this.connectionState)
				}
			}
		})()
		;(async () => {
			while (this.alive) {
				for await (const event of this.socket?.listener('error') || []) {
					this.connectionState = 'DISCONNECTED'
					this.emit('socketstate', this.connectionState)
				}
			}
		})()
		;(async () => {
			while (this.alive) {
				for await (let data of this.socket?.subscribe('companion-banks:' + this.companionId)) {
					if (data.type === 'single') {
						this.emit('bank', data as SingleBank & { updateId: string })
					} else if (data.type === 'all') {
						this.emit('banks', data as { updateId: string, data: MultiBank })
					}
				}
			}
		})()
		;(async () => {
			while (this.alive) {
				for await (let data of this.socket?.subscribe('companion-regions:' + this.companionId)) {
					this.emit('regions', data as RegionDetails[] & { updateId: string })
				}
			}
		})()
	}

	/**
	 * Destroys this object and disconnects from the cloud
	 *
	 * NB: Never use this object again after calling this method
	 */
	async destroy() {
		// Stop event handler loops
		this.alive = false

		// Kill it with fire
		this.socket.killAllChannels()
		this.socket.killAllListeners()
		this.socket.disconnect()

		this.removeAllListeners()

		// sorry, I don't want to have socket as a optional property
		// this.socket will only be undefined after it should be deleted/garbage collected
		let thes = this as any
		delete thes.socket
	}
}
