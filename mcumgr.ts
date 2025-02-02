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

export type McuImageInfo = {
	imageSize: number;
	version: string;
	hash: string;
};

export class McuManager {
    static readonly SERVICE_UUID = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
    static readonly CHARACTERISTIC_UUID = 'da2e7828-fbce-4e01-ae9e-261174997c48';

    private _mtu: number;
    private _device: BluetoothDevice | null;
    private _service: BluetoothRemoteGATTService | null;
    private _characteristic: BluetoothRemoteGATTCharacteristic | null;

    private _connectCallback: null | (() => void);
    private _connectingCallback: null | (() => void);
    private _disconnectCallback: null | (() => void);
    private _messageCallback: null | ((message: {op: number, group: number, id: number, data:any, length: number}) => void);
    private _imageUploadProgressCallback: null | ((event: {percentage: number}) => void);
    private _imageUploadFinishedCallback: null | (() => void);

    private _uploadIsInProgress: boolean;
    private _buffer: Uint8Array;
    private _logger: Logger;
    private _seq;
    private _uploadOffset;
    private _userRequestedDisconnect;
	private _uploadImage: ArrayBuffer | null;
    private _uploadTimeout: number | null;
    private _uploadSlot: number;

    constructor(di: null | {logger?: Logger}) {
        this._mtu = 400;
        this._device = null;
        this._service = null;
        this._characteristic = null;
        this._connectCallback = null;
        this._connectingCallback = null;
        this._disconnectCallback = null;
        this._messageCallback = null;
        this._imageUploadProgressCallback = null;
        this._imageUploadFinishedCallback = null;
        this._uploadIsInProgress = false;
        this._buffer = new Uint8Array();
        this._logger = di?.logger ?? {
            debug: (...args: any[]) => console.debug('McuMgr:', ...args),
            info: (...args: any[]) => console.log('McuMgr:', ...args),
            error: (...args: any[]) => console.error('McuMgr:', ...args),
        };
        this._seq = 0;
        this._uploadOffset = 0;
        this._userRequestedDisconnect = false;
        this._uploadImage = null;
        this._uploadTimeout = null;
        this._uploadSlot = 0;

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
    private _connect(timeout: number = 1000) {
        setTimeout(async () => {
            try {
                if (this._connectingCallback)
                    this._connectingCallback();
                const server = await this._device?.gatt?.connect();
                if (server === undefined){
                    this._logger.error("Could not connect");
                    return;
                }
                this._logger.info(`Server connected.`);
                this._service = await server.getPrimaryService(McuManager.SERVICE_UUID);
                this._logger.info(`Service connected.`);
                this._characteristic = await this._service.getCharacteristic(McuManager.CHARACTERISTIC_UUID);
                this._characteristic.addEventListener('characteristicvaluechanged', this._notification.bind(this));
                await this._characteristic.startNotifications();
                await this._connected();
                if (this._uploadIsInProgress) {
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
    onConnecting(callback: () => void) : McuManager{
        this._connectingCallback = callback;
        return this;
    }
    onConnect(callback: () => void): McuManager{
        this._connectCallback = callback;
        return this;
    }
    onDisconnect(callback: () => void): McuManager {
        this._disconnectCallback = callback;
        return this;
    }
    onMessage(callback: () => void): McuManager {
        this._messageCallback = callback;
        return this;
    }
    onImageUploadProgress(callback: () => void): McuManager {
        this._imageUploadProgressCallback = callback;
        return this;
    }
    onImageUploadFinished(callback: () => void): McuManager {
        this._imageUploadFinishedCallback = callback;
        return this;
    }
    private async _connected() {
        if (this._connectCallback)
            this._connectCallback();
    }
    private async _disconnected() {
        this._logger.info('Disconnected.');
        if (this._disconnectCallback)
            this._disconnectCallback();
        this._device = null;
        this._service = null;
        this._characteristic = null;
        this._uploadIsInProgress = false;
        this._userRequestedDisconnect = false;
    }
    get name(): string | null {
        return this._device?.name ?? null;
    }
	private async _sendMessage(op: number, group: number, id: number, data?: any): Promise<void> {
        const _flags = 0;
        let encodedData: number[] = [];
        if (typeof data !== 'undefined') {
            encodedData = [...cborg.encode(data)];
        }
        const length_lo = encodedData.length & 255;
        const length_hi = encodedData.length >> 8;
        const group_lo = group & 255;
        const group_hi = group >> 8;
        const message = [op, _flags, length_hi, length_lo, group_hi, group_lo, this._seq, id, ...encodedData];
        // this._logger.debug('>'  + message.map(x => x.toString(16).padStart(2, '0')).join(' '));
        await this._characteristic!.writeValueWithoutResponse(Uint8Array.from(message));
        this._seq = (this._seq + 1) % 256;
    }
    private _notification(event: Event) {
        // this._logger.info('message received');
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        const message = new Uint8Array(target.value!.buffer);
        // this._logger.info(message);
        // this._logger.debug('<'  + [...message].map(x => x.toString(16).padStart(2, '0')).join(' '));
        this._buffer = new Uint8Array([...this._buffer, ...message]);
        const messageLength = this._buffer[2] * 256 + this._buffer[3];
        if (this._buffer.length < messageLength + 8) return;
        this._processMessage(this._buffer.slice(0, messageLength + 8));
        this._buffer = this._buffer.slice(messageLength + 8);
    }
    private _processMessage(message: Uint8Array) {
        const [op, _flags, length_hi, length_lo, group_hi, group_lo, _seq, id] = message;
        const data = cborg.decode(message.slice(8));
        const length = length_hi * 256 + length_lo;
        const group = group_hi * 256 + group_lo;
        if (group === GroupId.Image && id === GroupImageId.Upload && (data.rc === 0 || data.rc === undefined) && data.off){
            // Clear timeout since we received a response
            if (this._uploadTimeout) {
                clearTimeout(this._uploadTimeout);
            }
            this._uploadOffset = data.off;
            this._uploadNext();
            return;
        }
        if (this._messageCallback)
            this._messageCallback({ op, group, id, data, length });
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
        return this._sendMessage(OpCode.Write, GroupId.Image, GroupImageId.State, { hash, confirm: false });
    }
    cmdImageConfirm(hash: Uint8Array): Promise<void> {
        return this._sendMessage(OpCode.Write, GroupId.Image, GroupImageId.State, { hash, confirm: true });
    }
    private _hash(image: BufferSource): Promise<ArrayBuffer> {
        return crypto.subtle.digest('SHA-256', image);
    }
    private async _uploadNext() {
        if (!this._uploadImage) {
			this._logger.error('No firmware upload to do...');
			return;
		}

        if (this._uploadOffset >= this._uploadImage.byteLength) {
            this._uploadIsInProgress = false;
            if (this._imageUploadFinishedCallback)
                this._imageUploadFinishedCallback();
            return;
        }

        // Clear any existing timeout
        if (this._uploadTimeout) {
            clearTimeout(this._uploadTimeout);
            this._uploadTimeout = null;
        }
        // Set new timeout
        this._uploadTimeout = window.setTimeout(() => {
            this._logger.info('Upload chunk timeout, retry');
            this._uploadNext();
        }, 100);

        const nmpOverhead = 8;
        type MCUPayload = {
			data: Uint8Array;
			off: number;
			len?: number;
			sha?: Uint8Array;
		};
        const message: MCUPayload = { data: new Uint8Array(), off: this._uploadOffset };
        if (this._uploadOffset === 0) {
            message.len = this._uploadImage.byteLength;
            message.sha = new Uint8Array(await this._hash(this._uploadImage));
        }
        if(this._imageUploadProgressCallback)
            this._imageUploadProgressCallback({ percentage: Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100) });

        const length = this._mtu - cborg.encode(message).byteLength - nmpOverhead;

        message.data = new Uint8Array(this._uploadImage.slice(this._uploadOffset, this._uploadOffset + length));

        // Keep offset for retry
        // this._uploadOffset += length;

        this._sendMessage(OpCode.Write, GroupId.Image, GroupImageId.Upload, message);
    }
    async cmdUpload(image: ArrayBuffer, slot: number = 0) {
        if (this._uploadIsInProgress) {
            this._logger.error('Upload is already in progress.');
            return;
        }
        this._uploadIsInProgress = true;

        this._uploadOffset = 0;
        this._uploadImage = image;
        this._uploadSlot = slot;

        this._uploadNext();
    }
    async imageInfo(image: ArrayBuffer): Promise<McuImageInfo> {
        // https://interrupt.memfault.com/blog/mcuboot-overview#mcuboot-image-binaries

        const view = new Uint8Array(image);

        // check header length
        if (view.length < 32) {
            throw new Error('Invalid image (too short file)');
        }

        // check MAGIC bytes 0x96f3b83d
        if (view[0] !== 0x3d || view[1] !== 0xb8 || view[2] !== 0xf3 || view[3] !== 0x96) {
            throw new Error('Invalid image (wrong magic bytes)');
        }

        // check load address is 0x00000000
        if (view[4] !== 0x00 || view[5] !== 0x00 || view[6] !== 0x00 || view[7] !== 0x00) {
            throw new Error('Invalid image (wrong load address)');
        }

        const headerSize = view[8] + view[9] * 2**8;

        // check protected TLV area size is 0
        if (view[10] !== 0x00 || view[11] !== 0x00) {
            throw new Error('Invalid image (wrong protected TLV area size)');
        }

        const imageSize = view[12] + view[13] * 2**8 + view[14] * 2**16 + view[15] * 2**24;

        // check image size is correct
        if (view.length < imageSize + headerSize) {
            throw new Error('Invalid image (wrong image size)');
        }

        // check flags is 0x00000000
        if (view[16] !== 0x00 || view[17] !== 0x00 || view[18] !== 0x00 || view[19] !== 0x00) {
            throw new Error('Invalid image (wrong flags)');
        }

        const version = `${view[20]}.${view[21]}.${view[22] + view[23] * 2**8}`;

        const hash = [...new Uint8Array(await this._hash(image.slice(0, imageSize + headerSize)))].map(b => b.toString(16).padStart(2, '0')).join('');

        return {hash, version, imageSize};
    }
}

