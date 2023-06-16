import { l } from '@dequanto/utils/$logger';
import { TestNode } from '../../dequanto/test/hardhat/TestNode';
import { HardhatProvider } from '@dequanto/hardhat/HardhatProvider';
import { $bigint } from '@dequanto/utils/$bigint';
import { ERC20 } from '@dequanto-contracts/openzeppelin/ERC20';
import { SafeUtils } from './SafeUtils';
import { TestUtils } from '../TestUtils';
import { File, FileSafe } from 'atma-io';
import { run } from 'shellbee';


UTest({
    $config: {
        timeout: 2 * 60 * 1000
    },
    async '$before'() {
        await TestUtils.clean();
        await TestNode.start();
    },
    async 'var'() {
        let provider = new HardhatProvider();
        let client = provider.client('localhost');
        let path = './test/fixtures/contracts/StorageCounter.sol';

        let { contract, abi } = await provider.deploySol(path, { client });

        let command = `node index i ${contract.address} --name Counter --chain hardhat --source ${path}`;

        l`Install: ${contract.address}`;
        let result = await run({
            command,
            silent: true,
        });
        return UTest({
            async 'check installation' () {
                let json = await File.readAsync<any>('./0xweb.json');
                let jsonHardhat = json.contracts.hardhat;
                deepEq_(jsonHardhat[contract.address], {
                    name: "Counter",
                    main: "./0xweb/hardhat/Counter/Counter.ts"
                });
            },
            async 'call method by contract name' () {
                let str = await TestUtils.cli(`contract read Counter getCountMethod --chain hardhat`);
                has_(str, /^1n$/m);
            },
            async 'call method by contract address' () {
                let str = await TestUtils.cli(`contract read ${ contract.address } "getCountMethod():uint256" --chain hardhat`);
                has_(str, /^1n$/m);
            },
            async 'check var' () {
                let str = await TestUtils.cli(`contract var Counter count --chain hardhat`);
                has_(str, /^1n$/m);
            },
            async 'check complex var' () {
                let str = await TestUtils.cli(`contract var Counter user`);
                has_(str, /"amount": "5"/m);
            },
            async 'list vars' () {
                let str = await TestUtils.cli(`contract vars Counter`);
                has_(str, /0\s+count/);
                has_(str, /1\s+user/);
            },
            async 'dump' () {
                let output = `cache/counter-dump/dump`;
                let jsonPath = `${output}.json`;

                async function cleanJson () {
                    await File.removeAsync(jsonPath);
                }

                return UTest({
                    async 'dump by name' () {
                        await cleanJson();
                        let str = await TestUtils.cli(`contract dump Counter --output cache/counter-dump/dump`);

                        has_(str, jsonPath);
                        let json = await File.readAsync<any>(jsonPath);

                        eq_(json.user.amount, '5');
                        eq_(json.count, '1');
                    },
                    async 'dump by address' () {
                        await cleanJson();
                        let str = await TestUtils.cli(`contract dump ${contract.address} --sources 0xweb/hardhat/Counter/Counter --output cache/counter-dump/dump --endpoint http://127.0.0.1:8545`);
                        console.log(`Str: ${str}`);

                        has_(str, jsonPath);
                        let json = await File.readAsync<any>(jsonPath);

                        eq_(json.user.amount, '5');
                        eq_(json.count, '1');
                    }
                })
            }
        });
    }
})
