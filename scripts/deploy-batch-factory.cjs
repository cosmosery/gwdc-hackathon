const { getRelayerWeb, getCompiled, waitForContract } = require('../src/tron.cjs');

async function main() {
  const web = getRelayerWeb();
  const artifact = getCompiled().BatchFactory;
  const factory = await web.contract().new({
    abi: artifact.abi,
    bytecode: artifact.evm.bytecode.object,
    feeLimit: 1_000_000_000,
    callValue: 0
  });
  const factoryAddress = web.address.fromHex(factory.address);
  await waitForContract(web, factoryAddress);
  const instance = web.contract(artifact.abi, factoryAddress);
  const implementationAddress = web.address.fromHex(await instance.implementation().call());
  await waitForContract(web, implementationAddress);
  console.log(JSON.stringify({ factoryAddress, implementationAddress }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
