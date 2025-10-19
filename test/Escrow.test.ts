import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import type { EscrowFactory, EscrowImplementation, MockUSDC } from "../typechain-types";

describe("EscrowTest", function () {
  const ORDER_ID = "ORDER_123";
  const PLATFORM_FEE_BIPS = 250; // 2.5%
  const RELEASE_AFTER = 7 * 24 * 60 * 60; // 7 days in seconds
  const METADATA_URI = "ipfs://QmTestMetadata";
  const AMOUNT = 100n * 10n**6n; // 100 USDC

  // Enum values match Solidity (starting at 0)
  const Status = {
    FUNDED: 0,
    RELEASED: 1,
    REFUNDED: 2,
    DISPUTED: 3,
    RESOLVED: 4
  };

  async function deployEscrowFixture() {
    const [owner, buyer, seller, feeCollector, arbitrator, other] = await hre.ethers.getSigners();

    // Deploy mock USDC
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    // Deploy Escrow Implementation
    const EscrowImplementation = await hre.ethers.getContractFactory("EscrowImplementation");
    const implementation = await EscrowImplementation.deploy();

    // Deploy Escrow Factory as Proxy (now upgradeable)
    const EscrowFactory = await hre.ethers.getContractFactory("EscrowFactory");
    const factory = await hre.upgrades.deployProxy(
      EscrowFactory,
      [
        await implementation.getAddress(),
        feeCollector.address,
        arbitrator.address,
        PLATFORM_FEE_BIPS
      ],
      { initializer: "initialize" }
    );

    await factory.waitForDeployment();

    // Mint USDC to buyer
    await usdc.mint(buyer.address, AMOUNT * 10n);

    return { factory, usdc, implementation, owner, buyer, seller, feeCollector, arbitrator, other };
  }

  async function deployEscrowWithFundedEscrowFixture() {
    const fixture = await deployEscrowFixture();
    const { factory, usdc, buyer, seller } = fixture;

    // Create and fund an escrow
    await usdc.connect(buyer).approve(await factory.getAddress(), AMOUNT);
    const tx = await factory.connect(buyer).createEscrow(
      ORDER_ID,
      seller.address,
      await usdc.getAddress(),
      AMOUNT,
      METADATA_URI,
      RELEASE_AFTER
    );

    const receipt = await tx.wait();
    const event = receipt?.logs.find((log: any) => {
      try {
        return factory.interface.parseLog(log)?.name === "EscrowCreated";
      } catch {
        return false;
      }
    });
    
    const parsedEvent = event ? factory.interface.parseLog(event) : null;
    const escrowAddress = parsedEvent?.args?.escrow;

    const EscrowImplementation = await hre.ethers.getContractFactory("EscrowImplementation");
    const escrow = EscrowImplementation.attach(escrowAddress) as EscrowImplementation;

    return { ...fixture, escrow, escrowAddress };
  }

  describe("Factory Deployment", function () {
    it("Should deploy factory with correct parameters", async function () {
      const { factory, implementation, feeCollector, arbitrator } = await loadFixture(deployEscrowFixture);

      expect(await factory.escrowImplementation()).to.equal(await implementation.getAddress());
      expect(await factory.feeCollector()).to.equal(feeCollector.address);
      expect(await factory.arbitrator()).to.equal(arbitrator.address);
      expect(await factory.defaultFeeBips()).to.equal(PLATFORM_FEE_BIPS);
      expect(await factory.getTotalEscrows()).to.equal(0);
    });
  });

  describe("Create Escrow", function () {
    it("Should create escrow successfully", async function () {
      const { factory, usdc, buyer, seller } = await loadFixture(deployEscrowFixture);

      await usdc.connect(buyer).approve(await factory.getAddress(), AMOUNT);

      await expect(
        factory.connect(buyer).createEscrow(
          ORDER_ID,
          seller.address,
          await usdc.getAddress(),
          AMOUNT,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.not.be.reverted;

      const escrowAddress = await factory.getEscrowAddress(ORDER_ID);
      expect(escrowAddress).to.not.equal(hre.ethers.ZeroAddress);
      expect(await factory.getTotalEscrows()).to.equal(1);
      expect(await factory.getUserEscrowCount(buyer.address)).to.equal(1);
      expect(await factory.getUserEscrowCount(seller.address)).to.equal(1);
      expect(await factory.isKnownEscrow(escrowAddress)).to.be.true;
    });

    it("Should verify escrow state after creation", async function () {
      const { escrow, buyer, seller, usdc } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      const basicInfo = await escrow.getBasicInfo();
      expect(basicInfo[0]).to.equal(buyer.address); // buyer
      expect(basicInfo[1]).to.equal(seller.address); // seller
      expect(basicInfo[2]).to.equal(await usdc.getAddress()); // token
      expect(basicInfo[3]).to.equal(AMOUNT); // amount
      expect(basicInfo[4]).to.equal(Status.FUNDED); // Status.FUNDED = 0
      
      expect(await escrow.isActive()).to.be.true;
      expect(await escrow.getBalance()).to.equal(AMOUNT);
    });

    it("Should revert when duplicate order ID is used", async function () {
      const { factory, usdc, buyer, seller } = await loadFixture(deployEscrowFixture);

      await usdc.connect(buyer).approve(await factory.getAddress(), AMOUNT * 2n);

      await factory.connect(buyer).createEscrow(
        ORDER_ID,
        seller.address,
        await usdc.getAddress(),
        AMOUNT,
        METADATA_URI,
        RELEASE_AFTER
      );

      await expect(
        factory.connect(buyer).createEscrow(
          ORDER_ID,
          seller.address,
          await usdc.getAddress(),
          AMOUNT,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.be.revertedWithCustomError(factory, "ORDER_EXISTS");
    });
  });

  describe("Buyer Release", function () {
    it("Should release funds to seller with correct fee", async function () {
      const { escrow, usdc, buyer, seller, feeCollector } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      const sellerBalanceBefore = await usdc.balanceOf(seller.address);
      const feeCollectorBalanceBefore = await usdc.balanceOf(feeCollector.address);

      await escrow.connect(buyer).buyerRelease();

      const sellerBalanceAfter = await usdc.balanceOf(seller.address);
      const feeCollectorBalanceAfter = await usdc.balanceOf(feeCollector.address);

      const platformFee = (AMOUNT * BigInt(PLATFORM_FEE_BIPS)) / 10000n;
      const sellerAmount = AMOUNT - platformFee;

      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(sellerAmount);
      expect(feeCollectorBalanceAfter - feeCollectorBalanceBefore).to.equal(platformFee);
      expect(await escrow.status()).to.equal(Status.RELEASED);
      expect(await escrow.getBalance()).to.equal(0);
    });

    it("Should revert when non-buyer tries to release", async function () {
      const { escrow, seller } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      await expect(
        escrow.connect(seller).buyerRelease()
      ).to.be.revertedWithCustomError(escrow, "ADDRESS_IS_NOT_BUYER");
    });
  });

  describe("Seller Refund", function () {
    it("Should refund buyer successfully", async function () {
      const { escrow, usdc, buyer, seller } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      const buyerBalanceBefore = await usdc.balanceOf(buyer.address);

      await escrow.connect(seller).sellerRefund();

      const buyerBalanceAfter = await usdc.balanceOf(buyer.address);

      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(AMOUNT);
      expect(await escrow.status()).to.equal(Status.REFUNDED);
      expect(await escrow.getBalance()).to.equal(0);
    });

    it("Should revert when non-seller tries to refund", async function () {
      const { escrow, buyer } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      await expect(
        escrow.connect(buyer).sellerRefund()
      ).to.be.revertedWithCustomError(escrow, "ADDRESS_IS_NOT_SELLER");
    });
  });

  describe("Auto Release", function () {
    it("Should auto-release after timelock expires", async function () {
      const { escrow, usdc, seller, feeCollector } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      // Fast forward time
      await time.increase(RELEASE_AFTER + 1);

      const sellerBalanceBefore = await usdc.balanceOf(seller.address);
      const feeCollectorBalanceBefore = await usdc.balanceOf(feeCollector.address);

      await escrow.autoRelease();

      const sellerBalanceAfter = await usdc.balanceOf(seller.address);
      const feeCollectorBalanceAfter = await usdc.balanceOf(feeCollector.address);

      const platformFee = (AMOUNT * BigInt(PLATFORM_FEE_BIPS)) / 10000n;
      const sellerAmount = AMOUNT - platformFee;

      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(sellerAmount);
      expect(feeCollectorBalanceAfter - feeCollectorBalanceBefore).to.equal(platformFee);
      expect(await escrow.status()).to.equal(Status.RELEASED);
    });

    it("Should revert when auto-release is called too early", async function () {
      const { escrow } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      await expect(
        escrow.autoRelease()
      ).to.be.revertedWithCustomError(escrow, "RELEASE_OF_FUNDS_IS_TOO_EARLY");
    });

    it("Should return correct canAutoRelease status", async function () {
      const { escrow } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      expect(await escrow.canAutoRelease()).to.be.false;

      await time.increase(RELEASE_AFTER + 1);

      expect(await escrow.canAutoRelease()).to.be.true;
    });
  });

  describe("Dispute Flow", function () {
    it("Should raise dispute successfully", async function () {
      const { escrow, buyer } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      const reason = "Item not delivered";
      await escrow.connect(buyer).raiseDispute(reason);

      expect(await escrow.status()).to.equal(Status.DISPUTED);

      const disputeInfo = await escrow.getDisputeInfo();
      expect(disputeInfo[0]).to.be.true; // hasDispute
      expect(disputeInfo[1]).to.equal(buyer.address); // raisedBy
      expect(disputeInfo[2]).to.equal(reason); // reason
    });

    it("Should resolve dispute in favor of buyer (refund)", async function () {
      const { factory, escrow, escrowAddress, usdc, buyer, arbitrator } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      await escrow.connect(buyer).raiseDispute("Item not delivered");

      const buyerBalanceBefore = await usdc.balanceOf(buyer.address);

      await factory.connect(arbitrator).resolveDispute(escrowAddress, buyer.address);

      const buyerBalanceAfter = await usdc.balanceOf(buyer.address);

      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(AMOUNT);
      expect(await escrow.status()).to.equal(Status.RESOLVED);
    });

    it("Should resolve dispute in favor of seller (release with fee)", async function () {
      const { factory, escrow, escrowAddress, usdc, seller, buyer, arbitrator, feeCollector } = 
        await loadFixture(deployEscrowWithFundedEscrowFixture);

      await escrow.connect(seller).raiseDispute("Buyer won't release");

      const sellerBalanceBefore = await usdc.balanceOf(seller.address);
      const feeCollectorBalanceBefore = await usdc.balanceOf(feeCollector.address);

      await factory.connect(arbitrator).resolveDispute(escrowAddress, seller.address);

      const sellerBalanceAfter = await usdc.balanceOf(seller.address);
      const feeCollectorBalanceAfter = await usdc.balanceOf(feeCollector.address);

      const platformFee = (AMOUNT * BigInt(PLATFORM_FEE_BIPS)) / 10000n;
      const sellerAmount = AMOUNT - platformFee;

      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(sellerAmount);
      expect(feeCollectorBalanceAfter - feeCollectorBalanceBefore).to.equal(platformFee);
      expect(await escrow.status()).to.equal(Status.RESOLVED);
    });

    it("Should revert when non-arbitrator tries to resolve dispute", async function () {
      const { factory, escrow, escrowAddress, buyer } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      await escrow.connect(buyer).raiseDispute("Test dispute");

      await expect(
        factory.connect(buyer).resolveDispute(escrowAddress, buyer.address)
      ).to.be.revertedWithCustomError(factory, "ADDRESS_IS_NOT_ARBITRATOR");
    });

    it("Should revert when resolving with invalid winner", async function () {
      const { factory, escrow, escrowAddress, buyer, arbitrator, other } = 
        await loadFixture(deployEscrowWithFundedEscrowFixture);

      await escrow.connect(buyer).raiseDispute("Test dispute");

      await expect(
        factory.connect(arbitrator).resolveDispute(escrowAddress, other.address)
      ).to.be.revertedWithCustomError(escrow, "INVALID_WINNER");
    });

    it("Should return empty dispute info when no dispute exists", async function () {
      const { escrow } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      const disputeInfo = await escrow.getDisputeInfo();
      expect(disputeInfo[0]).to.be.false; // hasDispute
      expect(disputeInfo[1]).to.equal(hre.ethers.ZeroAddress); // raisedBy
      expect(disputeInfo[2]).to.equal(""); // reason
    });
  });

  describe("Enhanced Getters", function () {
    it("Should return correct fee info", async function () {
      const { escrow, feeCollector } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      const feeInfo = await escrow.getFeeInfo();
      const expectedFee = (AMOUNT * BigInt(PLATFORM_FEE_BIPS)) / 10000n;
      
      expect(feeInfo[0]).to.equal(PLATFORM_FEE_BIPS); // feeBips
      expect(feeInfo[1]).to.equal(feeCollector.address); // collector
      expect(feeInfo[2]).to.equal(expectedFee); // feeAmount
      expect(feeInfo[3]).to.equal(AMOUNT - expectedFee); // netAmount
    });

    it("Should return correct timestamps", async function () {
      const { escrow } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      const timestamps = await escrow.getTimestamps();
      const currentTime = await time.latest();
      
      expect(timestamps[0]).to.be.closeTo(BigInt(currentTime), 10n); // createdAt
      expect(timestamps[1]).to.equal(timestamps[0] + BigInt(RELEASE_AFTER)); // releaseAfter
      expect(timestamps[2]).to.be.gt(0); // timeLeft
    });

    it("Should return correct status string", async function () {
      const { escrow } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      expect(await escrow.getStatusString()).to.equal("ACTIVE");
    });

    it("Should return correct basic info", async function () {
      const { escrow, buyer, seller, usdc } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      const basicInfo = await escrow.getBasicInfo();
      expect(basicInfo[0]).to.equal(buyer.address);
      expect(basicInfo[1]).to.equal(seller.address);
      expect(basicInfo[2]).to.equal(await usdc.getAddress());
      expect(basicInfo[3]).to.equal(AMOUNT);
      expect(basicInfo[4]).to.equal(Status.FUNDED); // 0
    });
  });

  describe("Factory Getters", function () {
    it("Should return correct status counts", async function () {
      const { factory, usdc, buyer, seller } = await loadFixture(deployEscrowFixture);

      await usdc.connect(buyer).approve(await factory.getAddress(), AMOUNT * 3n);

      await factory.connect(buyer).createEscrow("ORDER1", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);
      await factory.connect(buyer).createEscrow("ORDER2", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);
      await factory.connect(buyer).createEscrow("ORDER3", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);

      const statusCounts = await factory.getStatusCounts();
      expect(statusCounts[0]).to.equal(3); // funded
      expect(statusCounts[1]).to.equal(0); // released
      expect(statusCounts[2]).to.equal(0); // refunded
      expect(statusCounts[3]).to.equal(0); // disputed
      expect(statusCounts[4]).to.equal(0); // resolved
    });

    it("Should return correct factory stats", async function () {
      const { factory, usdc, buyer, seller, feeCollector, arbitrator } = await loadFixture(deployEscrowFixture);

      await usdc.connect(buyer).approve(await factory.getAddress(), AMOUNT * 3n);

      await factory.connect(buyer).createEscrow("ORDER1", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);
      await factory.connect(buyer).createEscrow("ORDER2", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);
      await factory.connect(buyer).createEscrow("ORDER3", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);

      const stats = await factory.getFactoryStats();
      expect(stats[0]).to.equal(3); // totalEscrows
      expect(stats[1]).to.equal(AMOUNT * 3n); // totalVolume
      expect(stats[2]).to.equal(PLATFORM_FEE_BIPS); // feeBips
      expect(stats[3]).to.equal(feeCollector.address); // collector
      expect(stats[4]).to.equal(arbitrator.address); // arbitrator
    });

    it("Should return user escrows correctly", async function () {
      const { factory, usdc, buyer, seller } = await loadFixture(deployEscrowFixture);

      await usdc.connect(buyer).approve(await factory.getAddress(), AMOUNT * 3n);

      await factory.connect(buyer).createEscrow("ORDER1", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);
      await factory.connect(buyer).createEscrow("ORDER2", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);
      await factory.connect(buyer).createEscrow("ORDER3", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);

      const buyerEscrows = await factory.getUserEscrows(buyer.address);
      expect(buyerEscrows.length).to.equal(3);

      const sellerEscrows = await factory.getUserEscrows(seller.address);
      expect(sellerEscrows.length).to.equal(3);
    });

    it("Should return escrows by status", async function () {
      const { factory, usdc, buyer, seller } = await loadFixture(deployEscrowFixture);

      await usdc.connect(buyer).approve(await factory.getAddress(), AMOUNT * 3n);

      await factory.connect(buyer).createEscrow("ORDER1", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);
      await factory.connect(buyer).createEscrow("ORDER2", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);
      await factory.connect(buyer).createEscrow("ORDER3", seller.address, await usdc.getAddress(), AMOUNT, METADATA_URI, RELEASE_AFTER);

      const fundedEscrows = await factory.getEscrowsByStatus(Status.FUNDED); // 0
      expect(fundedEscrows.length).to.equal(3);
    });
  });

  describe("Status Transitions", function () {
    it("Should transition from FUNDED to RELEASED", async function () {
      const { escrow, buyer } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      expect(await escrow.status()).to.equal(Status.FUNDED);

      await escrow.connect(buyer).buyerRelease();

      expect(await escrow.status()).to.equal(Status.RELEASED);
    });

    it("Should transition from FUNDED to REFUNDED", async function () {
      const { escrow, seller } = await loadFixture(deployEscrowWithFundedEscrowFixture);

      expect(await escrow.status()).to.equal(Status.FUNDED);

      await escrow.connect(seller).sellerRefund();

      expect(await escrow.status()).to.equal(Status.REFUNDED);
    });

    it("Should transition from FUNDED to DISPUTED to RESOLVED", async function () {
      const { factory, escrow, escrowAddress, buyer, arbitrator } = 
        await loadFixture(deployEscrowWithFundedEscrowFixture);

      expect(await escrow.status()).to.equal(Status.FUNDED);

      await escrow.connect(buyer).raiseDispute("Test");
      expect(await escrow.status()).to.equal(Status.DISPUTED);

      await factory.connect(arbitrator).resolveDispute(escrowAddress, buyer.address);
      expect(await escrow.status()).to.equal(Status.RESOLVED);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle minimum amount", async function () {
      const { factory, usdc, buyer, seller } = await loadFixture(deployEscrowFixture);

      const minAmount = 1n;
      await usdc.connect(buyer).approve(await factory.getAddress(), minAmount);

      await expect(
        factory.connect(buyer).createEscrow(
          "MIN_ORDER",
          seller.address,
          await usdc.getAddress(),
          minAmount,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.not.be.reverted;
    });

    it("Should handle large amounts", async function () {
      const { factory, usdc, buyer, seller } = await loadFixture(deployEscrowFixture);

      const largeAmount = 1000000n * 10n**6n; // 1M USDC
      await usdc.mint(buyer.address, largeAmount);
      await usdc.connect(buyer).approve(await factory.getAddress(), largeAmount);

      await expect(
        factory.connect(buyer).createEscrow(
          "LARGE_ORDER",
          seller.address,
          await usdc.getAddress(),
          largeAmount,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.not.be.reverted;
    });
  });
});