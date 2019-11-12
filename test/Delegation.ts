import { ContractManagerContract,
    ContractManagerInstance,
    DelegationServiceContract,
    DelegationServiceInstance,
    SkaleTokenContract,
    SkaleTokenInstance } from "../types/truffle-contracts";

const ContractManager: ContractManagerContract = artifacts.require("./ContractManager");
const SkaleToken: SkaleTokenContract = artifacts.require("./SkaleToken");
const DelegationService: DelegationServiceContract = artifacts.require("./DelegationService");

import { currentTime, months, skipTime, skipTimeToDate } from "./utils/time";

import * as chai from "chai";
import * as chaiAsPromised from "chai-as-promised";
chai.should();
chai.use(chaiAsPromised);

contract("SkaleToken", ([owner, holder1, holder1bounty, holder2, validator]) => {
    let contractManager: ContractManagerInstance;
    let skaleToken: SkaleTokenInstance;
    let delegationService: DelegationServiceInstance;
    const defaultAmount = 100 * 1e18;

    beforeEach(async () => {
        contractManager = await ContractManager.new();
        skaleToken = await SkaleToken.new(contractManager.address, []);
        delegationService = await DelegationService.new();

        // each test will start from Nov 10
        await skipTimeToDate(web3, 10, 11);
    });

    describe("when holders have tokens", async () => {
        beforeEach(async () => {
            await skaleToken.mint(owner, holder1, defaultAmount.toString(), "0x", "0x");
        });

        months.forEach((month, monthIndex) => {
            let requestId: number;

            it("should send request for delegation starting from " + month, async () => {
                const { logs } = await skaleToken.delegate(validator, month, 0, "D2 is even", holder1bounty);
                assert.equal(logs.length, 1, "No Mint Event emitted");
                assert.equal(logs[0].event, "DelegationRequestIsSent");
                requestId = logs[0].args.id;
                await delegationService.listDelegationRequests().should.be.eventually.deep.equal([requestId]);
            });

            describe("when delegation request is sent", async () => {

                beforeEach(async () => {
                    const { logs } = await skaleToken.delegate(validator, month, 0, "D2 is even", holder1bounty);
                    assert.equal(logs.length, 1, "No Mint Event emitted");
                    assert.equal(logs[0].event, "DelegationRequestIsSent");
                    requestId = logs[0].args.id;
                });

                it("should not allow holder to spend tokens", async () => {
                    await skaleToken.transfer(holder2, 1, {from: holder1}).should.be.eventually.rejectedWith("Can't transfer tokens because delegation request is created");
                    await skaleToken.approve(holder2, 1, {from: holder1}).should.be.eventually.rejectedWith("Can't approve transfer bacause delegation request is created");
                    await skaleToken.send(holder2, 1, "", {from: holder1}).should.be.eventually.rejectedWith("Can't send tokens because delegation request is created");
                });

                it("should not allow holder to receive tokens", async () => {
                    await skaleToken.transfer(holder1, 1, {from: holder2}).should.be.eventually.rejectedWith("Can't transfer tokens because delegation request is created");
                });

                it("should accept delegation request", async () => {
                    await delegationService.accept(requestId, {from: validator});

                    await delegationService.listDelegationRequests().should.be.eventually.empty;
                });

                it("should unlock token if validator does not accept delegation request", async () => {
                    await skipTimeToDate(web3, 1, monthIndex);

                    await skaleToken.transfer(holder2, 1, {from: holder1});
                    await skaleToken.approve(holder2, 1, {from: holder1});
                    await skaleToken.send(holder2, 1, "", {from: holder1});

                    await skaleToken.balanceOf(holder1).should.be.deep.equal(defaultAmount - 3);
                });

                describe("when delegation request is accepted", async () => {
                    beforeEach(async () => {
                        await delegationService.accept(requestId, {from: validator});
                    });

                    it("should not allow to create node before 26th day of a month before delegation start",
                        async () => {
                        for (let currentMonth = 11;
                            currentMonth !== monthIndex;
                            currentMonth = (currentMonth + 1) % 12) {
                                await skipTimeToDate(web3, 25, currentMonth);
                                await delegationService.createNode(4444, 0, "127.0.0.1", "127.0.0.1", {from: validator})
                                    .should.be.eventually.rejectedWith("Not enough tokens");
                        }
                        await skipTimeToDate(web3, 25, monthIndex);
                        await delegationService.createNode(4444, 0, "127.0.0.1", "127.0.0.1", {from: validator})
                            .should.be.eventually.rejectedWith("Not enough tokens");
                    });
                });
            });
        });
    });
});
