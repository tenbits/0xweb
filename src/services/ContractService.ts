import di from 'a-di';
import alot from 'alot';
import { Directory, File, env } from 'atma-io';
import { PackageService } from './PackageService';
import { GeneratorFromAbi } from '@dequanto/gen/GeneratorFromAbi';
import { IPackageItem } from '@core/models/IPackageJson';
import { ContractReader } from '@dequanto/contracts/ContractReader';
import { TxTopicInMemoryProvider } from '@dequanto/txs/receipt/TxTopicInMemoryProvider';
import { ContractWriter } from '@dequanto/contracts/ContractWriter';
import { AccountsService } from './AccountsService';
import { TPlatform } from '@dequanto/models/TPlatform';
import { App } from '@core/app/App';
import { ITxWriterOptions } from '@dequanto/txs/TxWriter';
import { TAddress } from '@dequanto/models/TAddress';
import { PlatformFactory } from '@dequanto/chains/PlatformFactory';
import { $require } from '@dequanto/utils/$require';
import { FileServiceTransport } from '@dequanto/safe/transport/FileServiceTransport';
import { $account } from '@dequanto/utils/$account';
import { EoAccount } from '@dequanto/models/TAccount';
import { $is } from '@dequanto/utils/$is';
import { ITxLogItem } from '@dequanto/txs/receipt/ITxLogItem';
import { Web3Client } from '@dequanto/clients/Web3Client';
import { $abiParser } from '@dequanto/utils/$abiParser';
import { SlotsStorage } from '@dequanto/solidity/SlotsStorage';
import { ISlotVarDefinition } from '@dequanto/solidity/SlotsParser/models';
import { ContractDumpService } from './ContractDumpService';
import { ContractStream } from '@dequanto/contracts/ContractStream';
import { $logger, l } from '@dequanto/utils/$logger';
import { $abiValues } from '@core/utils/$abiValues';
import { ContractClassFactory } from '@dequanto/contracts/ContractClassFactory';
import { TAbiInput, TAbiItem } from '@dequanto/types/TAbi';
import { TEth } from '@dequanto/models/TEth';
import { $abiUtils } from '@dequanto/utils/$abiUtils';
import { ITxBuilderOptions } from '@dequanto/txs/ITxBuilderOptions';
import { ContractFactory } from '@core/factories/ContractFactory';
import { $abiInput } from '@core/utils/$abiInput';
import { BaseService } from './BaseService';


interface ICallParams {
    block?: string | number
    account?: TAddress
    chain?: TPlatform
    nonce?: number
    address?: TAddress
    safeTransport?: string
    abi?: string
}


export class ContractService extends BaseService {


    async printList(options?: { chain?: TPlatform }) {
        let packageService = di.resolve(PackageService);
        let pkgs = await packageService.getLocalPackages();
        if (options?.chain != null) {
            pkgs = pkgs.filter(pkg => pkg.platform === options.chain);
        }

        pkgs = alot(pkgs)
            .sortBy(x => x.platform)
            .thenBy(x => x.name)
            .toArray();

        let rows = pkgs.map(x => [
            x.name, x.address, x.platform, x.id ?? ''
        ]);
        this.printLogTable([
            ['Name', 'Address', 'Platform (default)', 'ID'],
            ...rows
        ]);
        return pkgs;
    }

    async formatAbi(pkg: IPackageItem, abi: TAbiItem[]): Promise<string> {

        let methods = await abi.filter(x => x.type === 'function');
        let reads = methods.filter(x => $abiUtils.isReadMethod(x));
        let writes = methods.filter(x => $abiUtils.isReadMethod(x) === false);

        let lines = [
            `bold<cyan<${pkg.main}>>`
        ];

        lines.push(`bold<Read>`);
        lines.push(...reads.map(this.stringifyAbi));

        lines.push('');
        lines.push(`bold<Write>`)
        lines.push(...writes.map(this.stringifyAbi));

        return lines.join('\n');
    }

    async abi(name: string): Promise<{ pkg: IPackageItem, abi: TAbiItem[] }> {
        let pkg = await this.getPackage(name);
        let abi = await this.getAbi(pkg);
        return { pkg, abi };
    }

    private async getAbiItem(method: string, pkg?: IPackageItem, params?: ICallParams) {
        if (method?.includes(`(`)) {
            return $abiParser.parseMethod(method);
        }
        if (params?.abi) {
            return $abiParser.parseMethod(params.abi);
        }
        let abi = await this.getAbi(pkg);
        let abiItem = abi.find(x => x.name === method && x.type === 'function');
        return abiItem;
    }

    async call(nameOrAddress: string, method: string, params: ICallParams, action: 'read' | 'write') {
        let pkg = $is.Address(nameOrAddress)
            ? { address: nameOrAddress } as IPackageItem
            : await this.getPackage(nameOrAddress);
        let abiItem = await this.getAbiItem(method, pkg, params);
        if (abiItem == null) {
            let str = [
                `Method ${method} not found. 0xweb c abi ${nameOrAddress} to view available methods.`,
                `Or provide the ABI e.g.: 0xweb c read ${nameOrAddress} "decimals() returns (uint16)"`
            ].join(' ');
            throw new Error(str);
        }

        let methodSignature = this.stringifyAbi(abiItem);
        let isRead = typeof action === 'string'
            ? action === 'read'
            : $abiUtils.isReadMethod(abiItem);

        let platform = params.chain ?? pkg.platform;
        if (platform !== this.app?.chain?.client.platform) {
            this.app.chain = await di
                .resolve(PlatformFactory)
                .get(platform as any);
        }

        this.printLog('')
        this.printLogTable([
            ['Contract', params.address ?? pkg.address],
            ['Platform', platform],
            ['Action', isRead ? 'READ' : 'WRITE'],
            ['Method', methodSignature.trim()],
        ]);
        this.printLog('')

        if (isRead) {
            return await this.$read(pkg, abiItem, params);
        }
        return await this.$write(pkg, abiItem, params);
    }
    async calldata(nameOrAddress: string, method: string, params: ICallParams) {
        let { pkg, abi, abiItem, contract, args } = await this.getContractInstance(nameOrAddress, method, params);

        let arr = [...args];
        let isRead = $abiUtils.isReadMethod(abiItem);
        if (isRead === false) {
            arr.unshift({});
        }

        let $data = await contract.$data()[method](...arr);
        this.printLog($data);
        return $data;
    }
    async calldataParse(nameOrAddress: string, hex: TEth.Hex, params?: ICallParams) {
        let { pkg, abi, abiItem, contract, args } = await this.getContractInstance(nameOrAddress, null, params);
        let $data = await contract.$parseInputData(hex);
        this.printLog($data);
        return $data;
    }

    async getContractInstance(nameOrAddress: string, method: string, params: { chain?: TPlatform, abi?: string }) {
        let pkg = $is.Address(nameOrAddress)
            ? { address: nameOrAddress } as IPackageItem
            : await this.getPackage(nameOrAddress);

        let abi: TAbiItem[];
        let abiItem: TAbiItem;
        if (pkg != null) {
            abi = await this.getAbi(pkg);
        }

        if (method != null) {
            abiItem = await this.getAbiItem(method, pkg, params);

            if (abiItem == null) {
                let str = [
                    `Method ${method} not found. 0xweb c abi ${nameOrAddress} to view available methods.`,
                    `Or provide the ABI e.g.: 0xweb c read ${nameOrAddress} "decimals() returns (uint16)"`
                ].join(' ');
                throw new Error(str);
            }
            if (abi == null) {
                abi = [abiItem];
            }
        }

        let platform = params?.chain ?? pkg.platform;
        if (platform !== this.app?.chain?.client.platform) {
            this.app.chain = await di
                .resolve(PlatformFactory)
                .get(platform as any);
        }


        let factory = new ContractFactory(this.app.chain.client);
        let contract = await factory.create({
            pkg, abi
        });
        let args = abiItem == null
            ? []
            : await this.getArguments(abiItem, params);

        return {
            pkg,
            abi,
            abiItem,
            args,
            contract,
        };
    }

    async logs(name: string, eventName: string, params: { output, format?: 'csv' | 'json' }) {
        let pkg = await this.getPackage(name);
        let abi = await this.getAbi(pkg);
        let event = abi.find(x => x.name === eventName && x.type === 'event');
        $require.notNull(event, `"${eventName}" is not a valid Event in Contract "${name}". Use "0xweb c ${name} abi" to view the contracts ABI`);

        await this.app.ensureChain(pkg.platform);

        let args = alot(event.inputs)
            .map(input => [input.name, params?.[input.name]])
            .filter(tuple => tuple[1] != null)
            .toDictionary(x => x[0], x => x[1]);

        let reader = await this.getContractReader({});
        let logs = await reader.getLogsParsed(event, {
            address: pkg.address,
            fromBlock: 'deployment',
            params: args
        });
        this.printLog(`Loaded bold<${logs.length}> ${eventName} Events`);

        let blockDates = await BlockDateLoader.load(this.app.chain.client, logs);

        function formatFromOutput(path: string) {
            if (path == null) {
                return null;
            }
            return /\.(?<ext>\w+)$/.exec(path)?.groups.ext;
        }

        let format = params.format ?? formatFromOutput(params.output) ?? 'json';
        $require.oneOf(format, ['csv', 'json']);

        let str: string = '';
        if (format === 'json') {
            let json = logs.map(log => ({
                block: {
                    number: log.blockNumber,
                    date: blockDates[log.blockNumber]
                },
                transactionHash: log.transactionHash,
                event: log.event,
                params: log.params
            }));
            str = JSON.stringify(json, null, '  ');
        }
        if (format === 'csv') {
            let headers = ['Block', 'Date', 'Tx', 'Event', ...event.inputs.map(x => x.name)].join(', ');
            let rows = logs.map(log => {
                let row = [
                    log.blockNumber,
                    blockDates[log.blockNumber]?.toISOString() ?? '',
                    log.transactionHash,
                    log.event,
                    ...log.arguments.map(arg => arg.value)
                ];
                return row.join(', ');
            });
            str = `${headers}\n${rows.join('\n')}`;
        }
        let output = params.output ?? `./cache/${eventName}_${pkg.address}.${format}`;
        let file = new File(output);

        this.printLog(`Loaded bold<green<${logs.length}>> Logs`);
        await file.writeAsync(str, { skipHooks: true });
        this.printLog(`File cyan<${file.uri.toString()}>`);
    }
    async dump(nameOrAddress: string | TAddress, params: {
        output?: string
        implementation?: TAddress
        fields?: string
        sources?: string
        contractName?: string
    }) {
        let dumpService = new ContractDumpService(this.app)
        let { files, json } = await dumpService.dump(nameOrAddress, params);
        if (files != null) {
            this.printLogTable([
                ['Slots', files.csv],
                ['JSON', files.json],
            ]);
            return;
        }

        console.dir(json, { depth: null, colors: true });
    }

    async dumpRestore(nameOrAddress: string | TAddress, params: {
        file: string
    }) {
        $require.True(await File.existsAsync(params.file), `${params.file} does not exist`);

        let dumpService = new ContractDumpService(this.app)
        let result = await dumpService.dumpRestore(nameOrAddress, params);
    }

    async slot(nameOrAddress: string | TAddress, slotOrRange: string) {
        let address = await this.getAddress(nameOrAddress);
        if (slotOrRange.includes('-')) {
            let [start, end] = slotOrRange.split('-').map(Number);
            let slots = alot.fromRange(start, end + 1).toArray();
            let values = await this.app.chain.client.getStorageAtBatched(address, slots);
            values.forEach((value, index) => {
                this.printLogTable([
                    [slots[index], value],
                ]);
            });
            return;
        }
        let slot = slotOrRange as TEth.Hex;
        let slotValue = await this.app.chain.client.getStorageAt(address, slot);
        this.printLog(slotValue);
        return slotValue;
    }

    async varList(nameOrAddress: string | TAddress) {
        let pkg = await this.getPackage(nameOrAddress);
        let slots = await this.getSlots(pkg);

        let rows = slots
            // SlotsParser adds `$` at the end of the name when a property was overridden in inheritance
            .filter(slot => /\$$/.test(slot.name) === false)
            .map(slot => {
                return [slot.slot, slot.position, slot.name, slot.type?.replace(/=>/g, '→')]
            });
        this.printLogTable([
            ['Slot', 'Offset', 'Variable', 'Type'],
            ...rows
        ]);
        return slots;
    }
    async varLoad(nameOrAddress: string | TAddress, path: string, info?: {
        slot?: number
        type?: string
        offset?: string
    }) {
        let storage: SlotsStorage;
        if ($is.Address(nameOrAddress) && info?.slot != null && info?.type != null) {
            let name = /^[\w_]+/.exec(path)[0];
            let slots = [
                { name, type: info.type, slot: Number(info.slot), position: 0, size: null },
            ];
            storage = SlotsStorage.createWithClient(this.app.chain.client, nameOrAddress, slots);
        } else {
            let pkg = await this.getPackage(nameOrAddress);
            let slots = await this.getSlots(pkg);
            storage = SlotsStorage.createWithClient(this.app.chain.client, pkg.address, slots);
        }
        this.printLogToast(`Loading storage of "${path}"`);
        let result = await storage.get(path);
        if (result != null && typeof result === 'object') {
            this.printLog(JSON.stringify(result, null, '  '));
        } else {
            this.printLog(result);
        }
        return result;
    }

    async varSet(name: string, path: string, value: string, info?: {
        type?: string
    }) {
        let pkg = await this.getPackage(name);
        let slots = await this.getSlots(pkg);
        let storage = SlotsStorage.createWithClient(this.app.chain.client, pkg.address, slots);

        this.printLogToast(`Writing storage of "${path}"`);
        await storage.set(path, value);

        this.printLogToast(`Loading storage of "${path}"`);
        let result = await storage.get(path);
        if (result != null && typeof result === 'object') {
            this.printLog(JSON.stringify(result, null, '  '));
            return;
        }
        this.printLog(result);
    }

    async watchLog(nameOrAddress: string | TAddress, params: { event?: string, tx?: string, filters }) {
        let pkg = await this.getPackage(nameOrAddress);
        let abi = await this.getAbi(pkg);

        if (params.event) {
            let streamHandler = new ContractStream(pkg.address, abi, this.app.chain.client);
            let stream = streamHandler.on(params.event);

            stream.onConnected(() => this.printLogToast(`green<WebSocket Connected>`));
            stream.onData(event => {
                this.printLog($abiValues.serializeLog(event));
            });
        }
        if (params.tx) {
            let { contract } = ContractClassFactory.fromAbi(pkg.address, abi, this.app.chain.client, this.app.chain.explorer);
            let stream = contract.$onTransaction({ filter: { method: '*' } });

            stream.subscribe(info => {
                this.printLog($abiValues.serializeCalldata(info.calldata, abi));
            });
        }
    }

    private async $read(pkg: IPackageItem, abi: TAbiItem, params: ICallParams) {
        let address = params.address ?? pkg.address;
        $require.Address(address, 'Contracts address invalid');

        let args = await this.getArguments(abi, params);
        if (params.account != null && $is.Address(params.account) === false) {
            let accounts = di.resolve(AccountsService, this.app.config);
            let account = await accounts.get(params.account);
            params.account = account?.address ?? void 0;
        }

        let reader = await this.getContractReader(params);
        let result = await reader.readAsync(address, abi, ...args);

        let output = result != null && typeof result === 'object'
            ? JSON.stringify(result, null, '  ')
            : result;
        this.printLog(output);

        return result;
    }
    private async getContractReader(params: { block?, account?}) {
        let reader = di.resolve(ContractReader, this.app.chain.client);
        if (params.block) {
            let block: number | Date;
            if (/^\d+$/.test(params.block as string)) {
                block = Number(params.block)
            } else {
                block = new Date(params.block);
                if (isNaN(block.valueOf())) {
                    throw new Error(`Date format is invalid ${params.block}`);
                }
            }
            reader.forBlock(block);
        }
        if (params.account) {
            reader.withAddress(params.account);
        }
        return reader;
    }
    private async $write(pkg: IPackageItem, abi: TAbiItem, params: ICallParams) {
        let args = await this.getArguments(abi, params);
        let writer = await this.getContractWriter(pkg, abi, params);

        let accounts = di.resolve(AccountsService, this.app.config);
        let account = await accounts.get(params.account);
        let writerConfig = <ITxWriterOptions>{

        };
        if ($account.isSafe(account) && params.safeTransport) {
            let sender: EoAccount = $account.getSender(account);
            if (sender.key == null) {
                sender = await accounts.get(sender.address ?? sender.name) as EoAccount;
            }
            writerConfig.safeTransport = new FileServiceTransport(this.app.chain.client, sender, params.safeTransport);
        }

        let tx = await writer.writeAsync(account, abi, args, {
            builderConfig: <ITxBuilderOptions>{
                nonce: params.nonce
            },
            writerConfig,
        });
        if (this.app.config.env === 'api') {
            let hash = await tx.onSent;
            return { hash };
        }
        // In CLI wait for the Transaction to be mined
        let receipt = await tx.onCompleted;
        this.printLog(!receipt.status ? `red<bold<Failed>>` : `green<bold<OK>> ${receipt.transactionHash}`);
    }
    private async getContractWriter(pkg: IPackageItem, abi: TAbiItem, params: ICallParams) {

        let logParser = di.resolve(TxTopicInMemoryProvider);
        logParser.register(abi);

        let writer = di.resolve(ContractWriter, params.address ?? pkg.address, this.app.chain.client);
        return writer;
    }
    private async getArguments(abi: TAbiItem, params) {
        return $abiInput.parseArgumentsFromCli(abi as TEth.Abi.Item, params, {
            env: this.app.config.env
        });
    }
    private async getAddress(nameOrAddress): Promise<TAddress> {
        if ($is.Address(nameOrAddress)) {
            return nameOrAddress;
        }
        let pkg = await this.getPackage(nameOrAddress);
        return pkg.address;
    }
    private async getPackage(name: string) {
        let packageService = di.resolve(PackageService, this.app.chain);
        let pkg = await packageService.getPackage(name);
        if (pkg == null) {
            throw new Error(`Package ${name} not found. gray<0xweb c list> to view all installed contracts`);
        }
        if (this.app.chain == null) {
            this.app.chain = packageService.chain;
        }
        return pkg;
    }
    private async getAbi(pkg: IPackageItem) {
        let paths = [
            pkg.main.replace(/\.[a-z]+$/, '.json'),
            pkg.main.replace(/\.[a-z]+$/, 'Abi.json'),
        ];
        let path = await alot(paths).firstAsync(async path => await File.existsAsync(path));
        if (path == null) {
            throw new Error(`ABI file not found for ${pkg.main}`);
        }
        let mix = await File.readAsync<IJsonArtifact | TAbiItem[]>(path);
        if (Array.isArray(mix) === false && mix.abi != null) {
            mix = mix.abi;
        }
        $require.Array(mix, `"${path}" should contain an array of ABI items or artifacts JSON format.`);
        return mix as TAbiItem[];
    }
    private async getSlots(pkg: IPackageItem): Promise<ISlotVarDefinition[]> {
        let code = await File.readAsync<string>(pkg.main, { skipHooks: true });
        // parse from ts-generated code (consider to output slots in extra file like abi json)
        let rgxStart = /^\s*\$slots\s*=\s*\[/mg;
        let rgxStartMatch = rgxStart.exec(code);
        if (rgxStartMatch == null) {
            throw new Error(`${pkg.main} has no generated $slots field`);
        }
        let rgxEnd = /^\s*\]/mg;
        rgxEnd.lastIndex = rgxStartMatch.index;
        let rgxEndMatch = rgxEnd.exec(code);
        if (rgxEndMatch == null) {
            throw new Error(`${pkg.main}: End not found of the $slots value`);
        }
        let json = code.substring(rgxStartMatch.index + rgxStartMatch[0].length - 1, rgxEndMatch.index + 1);
        try {
            return JSON.parse(json);
        } catch (error) {
            this.printLog(json);
            throw error;
        }
    }
    private stringifyAbi(abi: TAbiItem) {
        let str = GeneratorFromAbi.Gen.serializeMethodAbi(abi, true);
        let line = '  ' + str.replace('function', '').trim();

        line = line.replace('returns', 'gray<returns>');
        line = line.replace(/(address|string|u?int\d+|bytes)/g, 'bold<blue<$1>>');
        line = line.replace(/([()])/g, 'green<$1>');
        return line;
    }

}


namespace BlockDateLoader {
    export async function load(client: Web3Client, logs: ITxLogItem[]) {
        let blockNrs = alot(logs).map(x => x.blockNumber).distinct().toArray();
        let min = alot(blockNrs).min(x => x);
        let max = alot(blockNrs).max(x => x);
        let MAX_REQ = 50;
        let MIN_STEP = 100;
        let step = Math.max(MIN_STEP, Math.floor((max - min) / MAX_REQ));

        let nrs = alot
            .fromRange(0, MAX_REQ)
            .map(i => min + (step * i))
            .filter(x => x < max)
            .toArray();

        nrs.push(max);

        let blocks = await client.getBlocks(nrs);
        this.printLog(`Loaded bold<${blockNrs.length}> block dates by approx ${nrs.length}`);


        let knownDates = alot(blocks).map(block => [block.number, Number(block.timestamp)] as const).toArray();

        let dates = alot(blockNrs).map(nr => {
            let a: (typeof knownDates[0]);
            let b: (typeof knownDates[0]);
            for (let i = 0; i < knownDates.length - 1; i++) {
                a = knownDates[i];
                b = knownDates[i + 1];
                let [aNr, aTime] = a;
                let [bNr, bTime] = b;
                if (aNr >= nr && nr <= bNr) {
                    break;
                }
            }
            let [aNr, aTime] = a;
            let [bNr, bTime] = b;
            let avg = (bTime - aTime) / (bNr - aNr);

            let startTime = aTime;
            let rangeTime = (nr - aNr) * avg;
            let time = startTime + rangeTime;

            return [nr, time];
        })
            .toDictionary(x => x[0], x => new Date(Number(x[1]) * 1000))

        return dates;
    }
}



interface IJsonArtifact {
    abi: TAbiItem[]
    bytecode: TEth.Hex
    contractName: string
    linkReferences: Record<string /* path */, Record<string /* name */, any>>
}
