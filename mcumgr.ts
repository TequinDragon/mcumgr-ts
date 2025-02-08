import * as cborg from 'cborg';

// Opcodes
export enum OpCode {
	Read = 0,
	ReadResponse = 1,
	Write = 2,
	WriteResponse = 3,
}

// Groups
export enum GroupId {
	OS = 0,
	Image = 1,
	Stat = 2,
	Config = 3,
	Log = 4,
	Crash = 5,
	Split = 6,
	Run = 7,
	FileSystem = 8,
	Shell = 9,
}

// OS group
export enum GroupOSId {
	Echo = 0,
	ConsoleEchoControl = 1,
	TaskStat = 2,
	Mpstat = 3,
	Datetime = 4,
	Reset = 5,
}

// Image group
export enum GroupImageId {
	State = 0,
	Upload = 1,
	File = 2,
	CoreList = 3,
	CoreLoad = 4,
	Erase = 5,
}

type Logger = {
	debug: (...data: any[]) => void;
	info: (...data: any[]) => void;
	error: (...data: any[]) => void;
};

export interface McuMgrMessage {
	readonly op: number;
	readonly group: number;
	readonly id: number;
	readonly data: { images: McuImageStat[] } | any;
	readonly length: number;
}

export type SemVersion = {
	major: number;
	minor: number;
	revision: number;
	build: number;
};

export interface McuImageStat {
	/** Is the current image actively running. */
	readonly active: boolean;
	readonly bootable: boolean;
	/** If the image is not confirmed, the bootloader will revert to the other image on reboot. */
	readonly confirmed: boolean;
	/** The SHA256 hash of the firmware image. */
	readonly hash: Uint8Array;
	/** If true, the bootloader will boot into this image on next reboot. */
	readonly pending: boolean;
	readonly permanent: boolean;
	readonly slot: number;
	readonly version: SemVersion;
}

export type McuImageInfo = {
	imageSize: number;
	version: SemVersion;
	hash: Uint8Array;
	hashValid: boolean;
	tags: { [tag: number]: Uint8Array };
};

interface McuMgrEventMap {
	connected: Event;
	connecting: Event;
	disconnected: Event;
	message: CustomEvent<McuMgrMessage>;
	imageUploadProgress: CustomEvent<{
		percentage: number;
		uploadedBytes: number;
		totalBytes: number;
	}>;
	imageUploadFinished: CustomEvent<{ hash: Uint8Array }>;
}

// Helper interface to superimpose our custom events (and Event types) to the EventTarget
// See: https://dev.to/43081j/strongly-typed-event-emitters-using-eventtarget-in-typescript-3658
interface McuMgrEventTarget extends EventTarget {
	addEventListener<K extends keyof McuMgrEventMap>(
		type: K,
		listener: (ev: McuMgrEventMap[K]) => void,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: EventListenerOptions | boolean,
	): void;
}

// Again, see: https://dev.to/43081j/strongly-typed-event-emitters-using-eventtarget-in-typescript-3658
const typedEventTarget = EventTarget as { new (): McuMgrEventTarget; prototype: McuMgrEventTarget };

export class McuManager extends typedEventTarget {
	static readonly SERVICE_UUID = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
	static readonly CHARACTERISTIC_UUID = 'da2e7828-fbce-4e01-ae9e-261174997c48';
	static readonly SMP_HEADER_SIZE = 8;

	private _mtu: number;
	private _device: BluetoothDevice | null;
	private _service: BluetoothRemoteGATTService | null;
	private _characteristic: BluetoothRemoteGATTCharacteristic | null;

	private _buffer: Uint8Array;
	private _logger: Logger;
	private _seq: number;
	private _userRequestedDisconnect;
	private _upload: {
		isInProgress: boolean,
		slot: number,
		offset: number,
		image: ArrayBuffer | null,
		imageInfo: McuImageInfo| null,
		timeoutId: number | null,
		retryTimeout: number,
		stats: {
			started: number,
			timer: number,
			retries: number,
		},
	};

	constructor(options?: { logger?: Logger, mtu?: number, retryTimeout?: number }) {
		super();

		this._mtu = options?.mtu ?? 400;
		this._device = null;
		this._service = null;
		this._characteristic = null;
		this._upload = {
			slot: 0,
			isInProgress: false,
			offset: 0,
			image: null,
			imageInfo: null,
			timeoutId: null,
			retryTimeout: options?.retryTimeout ?? 1000,
			stats:{
				started: 0,
				timer: 0,
				retries: 0,
			},

		}
		this._buffer = new Uint8Array();
		this._logger = options?.logger ?? {
			debug: (...args: any[]) => console.debug('McuMgr:', ...args),
			info: (...args: any[]) => console.log('McuMgr:', ...args),
			error: (...args: any[]) => console.error('McuMgr:', ...args),
		};
		this._seq = 0;
		this._userRequestedDisconnect = false;
	}

	private async _requestDevice(filters?: BluetoothLEScanFilter[]) {
		const params: RequestDeviceOptions =
			filters == undefined
				? {
						acceptAllDevices: true,
						optionalServices: [McuManager.SERVICE_UUID],
					}
				: {
						optionalServices: [McuManager.SERVICE_UUID],
						filters: filters,
						acceptAllDevices: false,
					};

		return navigator.bluetooth.requestDevice(params);
	}

	async connect(filters?: BluetoothLEScanFilter[]): Promise<void> {
		try {
			this._device = await this._requestDevice(filters);
			this._logger.info(`Connecting to device ${this.name}...`);
			this._device.addEventListener('gattserverdisconnected', async (event) => {
				this._logger.info(event);
				if (!this._userRequestedDisconnect) {
					this._logger.info('Trying to reconnect');
					this._connect(1000);
				} else {
					this._disconnected();
				}
			});
			this._connect(0);
		} catch (error) {
			this._logger.error(error);
			await this._disconnected();
			return;
		}
	}

	attach(device: BluetoothDevice) {
		this._device = device;
		this._connect(0);
	}

	private _connect(timeout: number = 1000) {
		setTimeout(async () => {
			try {
				this.dispatchEvent(new Event('connecting'));
				const server = await this._device?.gatt?.connect();
				if (server === undefined) {
					this._logger.error('Could not connect');
					return;
				}
				this._logger.info(`Server connected.`);
				this._service = await server.getPrimaryService(McuManager.SERVICE_UUID);
				this._logger.info(`Service connected.`);
				this._characteristic = await this._service.getCharacteristic(
					McuManager.CHARACTERISTIC_UUID,
				);
				this._characteristic.addEventListener(
					'characteristicvaluechanged',
					this._notification.bind(this),
				);
				await this._characteristic.startNotifications();
				await this._connected();
				if (this._upload.isInProgress) {
					this._uploadNext();
				}
			} catch (error) {
				this._logger.error(error);
				await this._disconnected();
			}
		}, timeout);
	}
	disconnect(): void {
		this._userRequestedDisconnect = true;
		this._device?.gatt?.disconnect();
	}
	private _connected() {
		this.dispatchEvent(new Event('connected'));
	}
	private async _disconnected() {
		this._logger.info('Disconnected.');
		this.dispatchEvent(new Event('disconnected'));
		this._device = null;
		this._service = null;
		this._characteristic = null;
		this._upload.isInProgress = false;
		this._userRequestedDisconnect = false;
	}
	get name(): string | null {
		return this._device?.name ?? null;
	}
	private async _sendMessage(op: number, group: number, id: number, data?: any): Promise<void> {
		const _flags = 0;
		let encodedData: number[] = [];
		if (data) {
			encodedData = [...cborg.encode(data)];
		}
		const length_lo = encodedData.length & 255;
		const length_hi = encodedData.length >> 8;
		const group_lo = group & 255;
		const group_hi = group >> 8;
		const message = [
			op,
			_flags,
			length_hi,
			length_lo,
			group_hi,
			group_lo,
			this._seq,
			id,
			...encodedData,
		];
		// this._logger.debug('>'  + message.map(x => x.toString(16).padStart(2, '0')).join(' '));
		await this._characteristic!.writeValueWithoutResponse(Uint8Array.from(message));
		this._seq = (this._seq + 1) % 256;
	}
	private _notification(event: Event) {
		const target = event.target as BluetoothRemoteGATTCharacteristic;
		const message = new Uint8Array(target.value!.buffer);
		// this._logger.debug('<'  + [...message].map(x => x.toString(16).padStart(2, '0')).join(' '));
		this._buffer = new Uint8Array([...this._buffer, ...message]);
		const messageLength = this._buffer[2] * 256 + this._buffer[3];

		// this._logger.debug('<'  + [...message].map(x => x.toString(16).padStart(2, '0')).join(' '));
		if (this._buffer.length < messageLength + McuManager.SMP_HEADER_SIZE) return;

		this._processMessage(this._buffer.slice(0, messageLength + McuManager.SMP_HEADER_SIZE));
		this._buffer = this._buffer.slice(messageLength + McuManager.SMP_HEADER_SIZE);
	}
	private _processMessage(message: Uint8Array) {
		const [op, _flags, length_hi, length_lo, group_hi, group_lo, _seq, id] = message;
		const data = cborg.decode(message.slice(8));
		const length = length_hi * 256 + length_lo;
		const group = group_hi * 256 + group_lo;
		// Note that "rc" may not be present if it is 0
		if (data.rc) {
			this._logger.debug('Got a non-zero response code');
			this._logger.debug(`Message: op: ${op}, group: ${group}, id: ${id}, length: ${length}`, data);
		} else if (group === GroupId.Image && id === GroupImageId.Upload && data.off) {
			// Keep track of time it took for a response
			const responseTime = performance.now();
			this._logger.debug(`Took ${responseTime - this._upload.stats.timer}ms to upload image segment`);
			this._upload.stats.timer = responseTime;

			// Clear timeout since we received a response
			if (this._upload.timeoutId) {
				clearTimeout(this._upload.timeoutId);
			}
			this._upload.offset = data.off;
			this._uploadNext();
			return;
		}

		this.dispatchEvent(new CustomEvent('message', { detail: { op, group, id, data, length } }));
	}
	cmdReset(): Promise<void> {
		return this._sendMessage(OpCode.Write, GroupId.OS, GroupOSId.Reset);
	}
	smpEcho(message: string): Promise<void> {
		return this._sendMessage(OpCode.Write, GroupId.OS, GroupOSId.Echo, { d: message });
	}
	cmdImageState(): Promise<void> {
		return this._sendMessage(OpCode.Read, GroupId.Image, GroupImageId.State);
	}
	cmdImageErase(): Promise<void> {
		return this._sendMessage(OpCode.Write, GroupId.Image, GroupImageId.Erase, {});
	}
	cmdImageTest(hash: Uint8Array): Promise<void> {
		return this._sendMessage(OpCode.Write, GroupId.Image, GroupImageId.State, {
			hash,
			confirm: false,
		});
	}
	cmdImageConfirm(hash: Uint8Array): Promise<void> {
		return this._sendMessage(OpCode.Write, GroupId.Image, GroupImageId.State, {
			hash,
			confirm: true,
		});
	}
	private _hash(image: BufferSource): Promise<ArrayBuffer> {
		return crypto.subtle.digest('SHA-256', image);
	}
	private async _uploadNext() {
		if (!this._upload.image) {
			this._logger.error('No firmware upload to do...');
			return;
		}

		if (this._upload.offset >= this._upload.image.byteLength) {
			this._logger.info(`Took ${performance.now() - this._upload.stats.started}ms to upload firmware. (${this._upload.stats.retries} retries)`);
			this._upload.isInProgress = false;
			this.dispatchEvent(
				new CustomEvent('imageUploadFinished', {
					detail: {
						hash: this._upload.imageInfo?.hash,
					},
				}),
			);
			return;
		}

		// Clear any existing timeout
		if (this._upload.timeoutId) {
			clearTimeout(this._upload.timeoutId);
			this._upload.timeoutId = null;
		}
		// Set new timeout
		this._upload.timeoutId = window.setTimeout(() => {
			// this._logger.info('Upload chunk timeout, retry');
			this._upload.stats.retries++;
			this._uploadNext();
		}, this._upload.retryTimeout);

		const nmpOverhead = 8;
		type MCUPayload = {
			data: Uint8Array;
			off: number;
			len?: number;
			sha?: Uint8Array;
		};
		const message: MCUPayload = { data: new Uint8Array(), off: this._upload.offset };
		if (this._upload.offset === 0) {
			message.len = this._upload.image.byteLength;
			message.sha = new Uint8Array(await this._hash(this._upload.image));
		}

		this.dispatchEvent(
			new CustomEvent('imageUploadProgress', {
				detail: {
					percentage: Math.floor((this._upload.offset / this._upload.image.byteLength) * 100),
					uploadedBytes: this._upload.offset,
					totalBytes: this._upload.image.byteLength,
				},
			}),
		);

		const length = this._mtu - cborg.encode(message).byteLength - nmpOverhead;

		message.data = new Uint8Array(
			this._upload.image.slice(this._upload.offset, this._upload.offset + length),
		);

		// Keep offset for retry
		// this._uploadOffset += length;

		await this._sendMessage(OpCode.Write, GroupId.Image, GroupImageId.Upload, message);
	}
	async cmdUpload(image: ArrayBuffer, slot: number = 0) {
		if (this._upload.isInProgress) {
			this._logger.error('Upload is already in progress.');
			return;
		}
		this._upload.isInProgress = true;

		this._upload.stats.timer = performance.now();
		this._upload.stats.started = performance.now();
		this._upload.stats.retries = 0;

		this._upload.offset = 0;
		this._upload.image = image;
		this._upload.imageInfo = await this.imageInfo(image);
		this._upload.slot = slot;

		await this._uploadNext();
	}

	private *_extractTlvs(data: ArrayBuffer): Generator<{ tag: number; value: Uint8Array }> {
		const view = new DataView(data);
		let offset = 0;
		while (offset < view.byteLength) {
			const tag = view.getUint16(offset, true);
			const len = view.getUint16(offset + 2, true);
			offset += 4;
			const data = view.buffer.slice(offset, offset + len);
			offset += len;

			yield { tag, value: new Uint8Array(data) };
		}
	}

	async imageInfo(image: ArrayBuffer): Promise<McuImageInfo> {
		// https://interrupt.memfault.com/blog/mcuboot-overview#mcuboot-image-binaries

		const littleEndian = true;
		const view = new DataView(image);

		// check header length
		if (view.byteLength < 32) {
			throw new Error('Invalid image (too short file)');
		}

		// check MAGIC bytes 0x96f3b83d
		if (view.getUint32(0, littleEndian) !== 0x96f3b83d)
			throw new Error('Invalid image (wrong magic bytes)');

		// check load address is 0x00000000
		if (view.getUint32(4, littleEndian) != 0) throw new Error('Invalid image (wrong load address)');

		const headerSize = view.getUint16(8, true);

		// Protected TLV area is included in the hash
		const protected_tlv_lenth = view.getUint16(10, littleEndian);

		const imageSize = view.getUint32(12, littleEndian);

		// check image size is correct
		if (view.byteLength < imageSize + headerSize)
			throw new Error('Invalid image (wrong image size)');

		// check flags is 0x00000000
		if (view.getUint32(16, littleEndian) !== 0) throw new Error('Invalid image (wrong flags)');

		const version: SemVersion = {
			major: view.getUint8(20),
			minor: view.getUint8(21),
			revision: view.getUint16(22, littleEndian),
			build: view.getUint32(24, littleEndian),
		};

		const hash = new Uint8Array(
			await this._hash(image.slice(0, headerSize + imageSize + protected_tlv_lenth)),
		);
		const info = { version, hash, hashValid: false, imageSize, tags: [] } as McuImageInfo;

		let offset = headerSize + imageSize;
		let tlv_end = offset;
		if (protected_tlv_lenth > 0) {
			if (view.getUint16(offset, littleEndian) !== 0x6908)
				throw new Error(
					`Expected protected TLV magic number. (0x${offset.toString(16)}: 0x${view.getUint16(offset, littleEndian).toString(16)})`,
				);

			tlv_end = view.getUint16(offset + 2, littleEndian) + offset;
			for (let tlv of this._extractTlvs(view.buffer.slice(offset + 4, tlv_end))) {
				info.tags[tlv.tag] = tlv.value;
			}
			offset = tlv_end;
		}

		if (view.getUint16(offset, littleEndian) !== 0x6907)
			throw new Error(
				`Expected TLV magic number. (0x${offset.toString(16)}: 0x${view.getUint16(offset, littleEndian).toString(16)})`,
			);

		tlv_end = view.getUint16(offset + 2, littleEndian) + offset;
		for (let tlv of this._extractTlvs(view.buffer.slice(offset + 4, tlv_end))) {
			info.tags[tlv.tag] = tlv.value;
		}

		if (16 in info.tags && info.tags[16].length == hash.length) {
			info.hashValid = info.tags[16].every((b, i) => b === hash[i]);
		}

		return info;
	}
}
