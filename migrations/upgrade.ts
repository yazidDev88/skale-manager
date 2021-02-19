import { contracts, getContractKeyInAbiFile, getContractFactory, verify, hashBytecode } from "./deploy";
import { ethers, network, upgrades, run, artifacts } from "hardhat";
import { promises as fs } from "fs";
import { ContractManager, Nodes } from "../typechain";
import { getImplementationAddress } from "@openzeppelin/upgrades-core";
import { getAbi } from "./tools";
import { deployLibraries, getLinkedContractFactory } from "../test/tools/deploy/factory";

export async function getAndUpgradeContractFactory(contract: string, abi: any) {
    const { linkReferences } = await artifacts.readArtifact(contract);
    if (!Object.keys(linkReferences).length)
        return await ethers.getContractFactory(contract);

    const librariesToUpgrade = [];
    const oldLibraries: {[k: string]: string} = {};
    for (const key of Object.keys(linkReferences)) {
        const libraryName = Object.keys(linkReferences[key])[0];
        const { bytecode } = await artifacts.readArtifact(libraryName);
        const libraryBytecodeHash = abi[getContractKeyInAbiFile(libraryName) + "_hashed_bytecode"];
        if (hashBytecode(bytecode) !== libraryBytecodeHash) {
            librariesToUpgrade.push(libraryName);
        } else {
            oldLibraries[libraryName] = abi[getContractKeyInAbiFile(libraryName) + "_address"];
        }
    }

    const libraries = await deployLibraries(librariesToUpgrade);
    for (const libraryName of Object.keys(libraries)) {
        const { bytecode } = await artifacts.readArtifact(libraryName);
        abi[getContractKeyInAbiFile(libraryName) + "_address"] =  libraries[libraryName];
        abi[getContractKeyInAbiFile(libraryName) + "_hashed_bytecode"] = hashBytecode(bytecode);
    }
    Object.assign(libraries, oldLibraries);
    return await getLinkedContractFactory(contract, libraries);
}

async function main() {
    if ((await fs.readFile("DEPLOYED", "utf-8")).trim() !== "1.7.2-stable.0") {
        console.log("Upgrade script is not relevant");
        process.exit(1);
    }

    if (!process.env.ABI) {
        console.log("Set path to file with ABI and addresses to ABI environment variables");
        return;
    }

    let multisig = false;
    if (process.env.MULTISIG) {
        console.log("Prepare upgrade for multisig");
        multisig = true;
    }

    const abiFilename = process.env.ABI;
    const abi = JSON.parse(await fs.readFile(abiFilename, "utf-8"));

    // remove Wallets from list
    contracts.pop();

    const contractsToUpgrade: string[] = [];
    for (const contract of ["ContractManager"].concat(contracts)) {
        const contractFactory = await getAndUpgradeContractFactory(contract, abi);
        let _contract = contract;
        if (contract === "BountyV2") {
            _contract = "Bounty";
        }
        const proxyAddress = abi[getContractKeyInAbiFile(_contract) + "_address"];


        const newImplementationAddress = await upgrades.prepareUpgrade(proxyAddress, contractFactory, { unsafeAllowLinkedLibraries: true });
        const currentImplementationAddress = await getImplementationAddress(network.provider, proxyAddress);
        if (newImplementationAddress !== currentImplementationAddress)
        {
            contractsToUpgrade.push(contract);
            await verify(contract, newImplementationAddress);
        } else {
            console.log(`Contract ${contract} is up to date`);
        }
    }

    if (multisig) {
        console.log("Instructions for multisig:");
    }
    for (const contract of contractsToUpgrade) {
        const contractFactory = await getAndUpgradeContractFactory(contract, abi);
        let _contract = contract;
        if (contract === "BountyV2") {
            _contract = "Bounty";
        }
        const proxyAddress = abi[getContractKeyInAbiFile(_contract) + "_address"];
        let contractInterface;
        if (multisig) {
            const newImplementationAddress =
                await upgrades.prepareUpgrade(proxyAddress, contractFactory, { unsafeAllowLinkedLibraries: true });
            contractInterface = contractFactory.attach(newImplementationAddress).interface;
            console.log(`Upgrade ${contract} at ${proxyAddress} to ${newImplementationAddress}`);
        } else {
            // TODO: initialize upgraded instance in the upgrade transaction
            console.log(`Upgrade ${contract} at ${proxyAddress}`);
            contractInterface = (await upgrades.upgradeProxy(proxyAddress, contractFactory, { unsafeAllowLinkedLibraries: true })).interface;
        }
        abi[getContractKeyInAbiFile(_contract) + "_abi"] = getAbi(contractInterface);
    }

    // Deploy Wallets
    const contractManagerName = "ContractManager";
    const contractManagerFactory = await ethers.getContractFactory(contractManagerName);
    const contractManager = (contractManagerFactory.attach(abi[getContractKeyInAbiFile(contractManagerName) + "_address"])) as ContractManager;

    const walletsName = "Wallets";
    console.log("Deploy", walletsName);
    const walletsFactory = await ethers.getContractFactory(walletsName);
    const wallets = await upgrades.deployProxy(walletsFactory, [contractManager.address]);
    await wallets.deployTransaction.wait();
    console.log("Register", walletsName);
    await (await contractManager.setContractsAddress(walletsName, wallets.address)).wait();
    abi[getContractKeyInAbiFile(walletsName) + "_address"] = wallets.address;
    abi[getContractKeyInAbiFile(walletsName) + "_abi"] = getAbi(wallets.interface);
    await verify(walletsName, await getImplementationAddress(network.provider, wallets.address));

    // Initialize SegmentTree in Nodes
    const nodesName = "Nodes";
    const nodesContractFactory = await getAndUpgradeContractFactory(nodesName, abi);
    const nodesAddress = abi[getContractKeyInAbiFile(nodesName) + "_address"];
    if (nodesAddress) {
        const nodes = (nodesContractFactory.attach(nodesAddress)) as Nodes;
        if (multisig) {
            console.log(`Call ${nodesName}.initializeSegmentTreeAndInvisibleNodes() at ${nodesAddress}`);
        } else {
            const receipt = await(await nodes.initializeSegmentTreeAndInvisibleNodes()).wait();
            console.log("SegmentTree was initialized with", receipt.gasUsed.toNumber(), "gas used");
        }
    } else {
        console.log("Nodes address was not found!");
        console.log("Check your abi!");
        process.exit(1);
    }

    const version = (await fs.readFile("VERSION", "utf-8")).trim();
    await fs.writeFile(`data/skale-manager-${version}-${network.name}-abi.json`, JSON.stringify(abi, null, 4));

    console.log("Done");
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}
