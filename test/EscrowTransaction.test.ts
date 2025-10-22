import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import type { EscrowTransaction } from "../typechain-types";

describe("EscrowTransaction", function () {
  const ORDER_ID = "ORDER_123";
  const METADATA_URI = "ipfs://QmTestMetadata";
  const AMOUNT = hre.ethers.parseEther("1.0"); // 1 ETH
  const RELEASE_AFTER = 7 * 24 * 60 * 60; // 7 days in seconds

  // Enum values match Solidity (starting at 0)
  const Status = {
    PENDING: 0,
    PAID: 1,
    CANCELLED: 2
  };

  async function deployEscrowTransactionFixture() {
    const [owner, seller, buyer, receiver, other] = await hre.ethers.getSigners();

    const EscrowTransaction = await hre.ethers.getContractFactory("EscrowTransaction");
    const escrowTransaction = await EscrowTransaction.deploy();
    await escrowTransaction.waitForDeployment();

    return { escrowTransaction, owner, seller, buyer, receiver, other };
  }

  async function deployWithTransactionFixture() {
    const fixture = await deployEscrowTransactionFixture();
    const { escrowTransaction, seller, receiver } = fixture;

    // Create a transaction
    const tx = await escrowTransaction.connect(seller).createTransaction(
      ORDER_ID,
      receiver.address,
      AMOUNT,
      hre.ethers.ZeroAddress, // Native token
      METADATA_URI,
      RELEASE_AFTER
    );

    await tx.wait();

    return { ...fixture };
  }

  describe("Deployment", function () {
    it("Should deploy successfully", async function () {
      const { escrowTransaction } = await loadFixture(deployEscrowTransactionFixture);

      expect(await escrowTransaction.getAddress()).to.be.properAddress;
    });
  });

  describe("Create Transaction", function () {
    it("Should create transaction successfully", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          ORDER_ID,
          receiver.address,
          AMOUNT,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.emit(escrowTransaction, "TransactionCreated")
        .withArgs(
          seller.address,
          receiver.address,
          ORDER_ID,
          AMOUNT,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        );

      // Verify transaction was stored correctly
      const transaction = await escrowTransaction.getTransactionByOrderId(ORDER_ID);
      expect(transaction.buyer).to.equal(hre.ethers.ZeroAddress);
      expect(transaction.receiver).to.equal(receiver.address);
      expect(transaction.amount).to.equal(AMOUNT);
      expect(transaction.token).to.equal(hre.ethers.ZeroAddress);
      expect(transaction.metadataUri).to.equal(METADATA_URI);
      expect(transaction.status).to.equal(Status.PENDING);
      expect(transaction.orderId).to.equal(ORDER_ID);
      expect(transaction.releaseAfter).to.equal(RELEASE_AFTER);
    });

    it("Should store transaction for seller", async function () {
      const { escrowTransaction, seller } = await loadFixture(deployWithTransactionFixture);

      const sellerTransactions = await escrowTransaction.getUserTransactions(seller.address);
      expect(sellerTransactions.length).to.equal(1);
      expect(sellerTransactions[0].orderId).to.equal(ORDER_ID);
      expect(sellerTransactions[0].status).to.equal(Status.PENDING);
    });

    it("Should revert when order ID is empty", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          "",
          receiver.address,
          AMOUNT,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.be.revertedWithCustomError(escrowTransaction, "ORDER_ID_EMPTY");
    });

    it("Should revert when receiver is zero address", async function () {
      const { escrowTransaction, seller } = await loadFixture(deployEscrowTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          ORDER_ID,
          hre.ethers.ZeroAddress,
          AMOUNT,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.be.revertedWithCustomError(escrowTransaction, "ADDRESS_CAN_NOT_BE_ADDRESS_ZERO");
    });

    it("Should revert when amount is zero", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          ORDER_ID,
          receiver.address,
          0,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.be.revertedWithCustomError(escrowTransaction, "AMOUNT_CAN_NOT_BE_ZERO");
    });

    it("Should revert when metadata URI is empty", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          ORDER_ID,
          receiver.address,
          AMOUNT,
          hre.ethers.ZeroAddress,
          "",
          RELEASE_AFTER
        )
      ).to.be.revertedWithCustomError(escrowTransaction, "METADATA_URI_IS_EMPTY");
    });

    it("Should revert when duplicate order ID is used", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployWithTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          ORDER_ID,
          receiver.address,
          AMOUNT,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.be.revertedWithCustomError(escrowTransaction, "ORDER_EXISTS");
    });
  });

  describe("Update Transaction with Escrow", function () {
    it("Should update transaction with escrow address successfully", async function () {
      const { escrowTransaction, seller, buyer, receiver } = await loadFixture(deployWithTransactionFixture);
      
      const escrowAddress = hre.ethers.Wallet.createRandom().address;

      await expect(
        escrowTransaction.updateTransactionWithEscrow(ORDER_ID, buyer.address, escrowAddress)
      ).to.emit(escrowTransaction, "TransactionUpdated")
        .withArgs(ORDER_ID, escrowAddress, Status.PAID);

      // Verify transaction was updated
      const transaction = await escrowTransaction.getTransactionByOrderId(ORDER_ID);
      expect(transaction.buyer).to.equal(buyer.address);
      expect(transaction.escrowAddress).to.equal(escrowAddress);
      expect(transaction.status).to.equal(Status.PAID);

      // Verify transaction was stored for buyer
      const buyerTransactions = await escrowTransaction.getUserTransactions(buyer.address);
      expect(buyerTransactions.length).to.equal(1);
      expect(buyerTransactions[0].orderId).to.equal(ORDER_ID);
      expect(buyerTransactions[0].status).to.equal(Status.PAID);
    });

    it("Should revert when order does not exist", async function () {
      const { escrowTransaction, buyer } = await loadFixture(deployEscrowTransactionFixture);

      const escrowAddress = hre.ethers.Wallet.createRandom().address;

      await expect(
        escrowTransaction.updateTransactionWithEscrow("NON_EXISTENT_ORDER", buyer.address, escrowAddress)
      ).to.be.revertedWithCustomError(escrowTransaction, "ORDER_DOES_NOT_EXIST");
    });

    it("Should revert when buyer is zero address", async function () {
      const { escrowTransaction } = await loadFixture(deployWithTransactionFixture);

      const escrowAddress = hre.ethers.Wallet.createRandom().address;

      await expect(
        escrowTransaction.updateTransactionWithEscrow(ORDER_ID, hre.ethers.ZeroAddress, escrowAddress)
      ).to.be.revertedWithCustomError(escrowTransaction, "ADDRESS_CAN_NOT_BE_ADDRESS_ZERO");
    });

    it("Should revert when escrow address is zero address", async function () {
      const { escrowTransaction, buyer } = await loadFixture(deployWithTransactionFixture);

      await expect(
        escrowTransaction.updateTransactionWithEscrow(ORDER_ID, buyer.address, hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(escrowTransaction, "ADDRESS_CAN_NOT_BE_ADDRESS_ZERO");
    });

    it("Should revert when transaction is already paid", async function () {
      const { escrowTransaction, buyer, receiver } = await loadFixture(deployWithTransactionFixture);

      const escrowAddress = hre.ethers.Wallet.createRandom().address;

      // First update
      await escrowTransaction.updateTransactionWithEscrow(ORDER_ID, buyer.address, escrowAddress);

      // Try to update again
      await expect(
        escrowTransaction.updateTransactionWithEscrow(ORDER_ID, buyer.address, escrowAddress)
      ).to.be.revertedWithCustomError(escrowTransaction, "TRANSACTION_ALREADY_PROCESSED");
    });

    it("Should revert when transaction is cancelled", async function () {
      const { escrowTransaction, seller, buyer } = await loadFixture(deployWithTransactionFixture);

      // Cancel transaction first
      await escrowTransaction.connect(seller).cancelTransaction(ORDER_ID);

      const escrowAddress = hre.ethers.Wallet.createRandom().address;

      await expect(
        escrowTransaction.updateTransactionWithEscrow(ORDER_ID, buyer.address, escrowAddress)
      ).to.be.revertedWithCustomError(escrowTransaction, "TRANSACTION_ALREADY_PROCESSED");
    });
  });

  describe("Cancel Transaction", function () {
    it("Should cancel transaction successfully", async function () {
      const { escrowTransaction, seller } = await loadFixture(deployWithTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).cancelTransaction(ORDER_ID)
      ).to.emit(escrowTransaction, "TransactionUpdated")
        .withArgs(ORDER_ID, hre.ethers.ZeroAddress, Status.CANCELLED);

      const transaction = await escrowTransaction.getTransactionByOrderId(ORDER_ID);
      expect(transaction.status).to.equal(Status.CANCELLED);
    });

    it("Should revert when non-seller tries to cancel", async function () {
      const { escrowTransaction, buyer } = await loadFixture(deployWithTransactionFixture);

      await expect(
        escrowTransaction.connect(buyer).cancelTransaction(ORDER_ID)
      ).to.be.revertedWithCustomError(escrowTransaction, "ADDRESS_IS_NOT_SELLER");
    });

    it("Should revert when order does not exist", async function () {
      const { escrowTransaction, seller } = await loadFixture(deployEscrowTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).cancelTransaction("NON_EXISTENT_ORDER")
      ).to.be.revertedWithCustomError(escrowTransaction, "ORDER_DOES_NOT_EXIST");
    });

    it("Should revert when transaction is already paid", async function () {
      const { escrowTransaction, seller, buyer } = await loadFixture(deployWithTransactionFixture);

      const escrowAddress = hre.ethers.Wallet.createRandom().address;
      await escrowTransaction.updateTransactionWithEscrow(ORDER_ID, buyer.address, escrowAddress);

      await expect(
        escrowTransaction.connect(seller).cancelTransaction(ORDER_ID)
      ).to.be.revertedWithCustomError(escrowTransaction, "TRANSACTION_ALREADY_PROCESSED");
    });
  });

  describe("Get Functions", function () {
    it("Should get user transactions correctly", async function () {
      const { escrowTransaction, seller } = await loadFixture(deployWithTransactionFixture);

      const transactions = await escrowTransaction.getUserTransactions(seller.address);
      expect(transactions.length).to.equal(1);
      expect(transactions[0].orderId).to.equal(ORDER_ID);
      expect(transactions[0].status).to.equal(Status.PENDING);
    });

    it("Should get transaction by order ID correctly", async function () {
      const { escrowTransaction } = await loadFixture(deployWithTransactionFixture);

      const transaction = await escrowTransaction.getTransactionByOrderId(ORDER_ID);
      expect(transaction.orderId).to.equal(ORDER_ID);
      expect(transaction.amount).to.equal(AMOUNT);
      expect(transaction.status).to.equal(Status.PENDING);
    });

    it("Should get user transactions by status", async function () {
      const { escrowTransaction, seller } = await loadFixture(deployWithTransactionFixture);

      // Get pending transactions
      const pendingTransactions = await escrowTransaction.getUserTransactionsByStatus(seller.address, Status.PENDING);
      expect(pendingTransactions.length).to.equal(1);
      expect(pendingTransactions[0].orderId).to.equal(ORDER_ID);

      // Get paid transactions (should be empty)
      const paidTransactions = await escrowTransaction.getUserTransactionsByStatus(seller.address, Status.PAID);
      expect(paidTransactions.length).to.equal(0);
    });

    it("Should check if order is pending", async function () {
      const { escrowTransaction } = await loadFixture(deployWithTransactionFixture);

      expect(await escrowTransaction.isOrderPending(ORDER_ID)).to.be.true;

      // Test non-existent order
      expect(await escrowTransaction.isOrderPending("NON_EXISTENT")).to.be.false;
    });

    it("Should get transaction count for user", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployWithTransactionFixture);

      expect(await escrowTransaction.getTransactionCount(seller.address)).to.equal(1);

      // Create another transaction
      await escrowTransaction.connect(seller).createTransaction(
        "ORDER_456",
        receiver.address,
        AMOUNT,
        hre.ethers.ZeroAddress,
        METADATA_URI,
        RELEASE_AFTER
      );

      expect(await escrowTransaction.getTransactionCount(seller.address)).to.equal(2);
    });

    it("Should get transaction for escrow parameters", async function () {
      const { escrowTransaction } = await loadFixture(deployWithTransactionFixture);

      const escrowParams = await escrowTransaction.getTransactionForEscrow(ORDER_ID);
      
      expect(escrowParams.seller).to.not.equal(hre.ethers.ZeroAddress);
      expect(escrowParams.receiver).to.not.equal(hre.ethers.ZeroAddress);
      expect(escrowParams.amount).to.equal(AMOUNT);
      expect(escrowParams.token).to.equal(hre.ethers.ZeroAddress);
      expect(escrowParams.metadataUri).to.equal(METADATA_URI);
      expect(escrowParams.releaseAfter).to.equal(RELEASE_AFTER);
    });

    it("Should return empty array for user with no transactions", async function () {
      const { escrowTransaction, other } = await loadFixture(deployWithTransactionFixture);

      const transactions = await escrowTransaction.getUserTransactions(other.address);
      expect(transactions.length).to.equal(0);
    });
  });

  describe("Multiple Transactions", function () {
    it("Should handle multiple transactions for same user", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      // Create multiple transactions
      const orders = ["ORDER_1", "ORDER_2", "ORDER_3"];
      
      for (const orderId of orders) {
        await escrowTransaction.connect(seller).createTransaction(
          orderId,
          receiver.address,
          AMOUNT,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        );
      }

      const sellerTransactions = await escrowTransaction.getUserTransactions(seller.address);
      expect(sellerTransactions.length).to.equal(3);

      // Verify all orders can be retrieved individually
      for (const orderId of orders) {
        const transaction = await escrowTransaction.getTransactionByOrderId(orderId);
        expect(transaction.orderId).to.equal(orderId);
        expect(transaction.status).to.equal(Status.PENDING);
      }
    });

    it("Should handle transactions with ERC20 tokens", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      const tokenAddress = hre.ethers.Wallet.createRandom().address;

      await escrowTransaction.connect(seller).createTransaction(
        "ERC20_ORDER",
        receiver.address,
        AMOUNT,
        tokenAddress,
        METADATA_URI,
        RELEASE_AFTER
      );

      const transaction = await escrowTransaction.getTransactionByOrderId("ERC20_ORDER");
      expect(transaction.token).to.equal(tokenAddress);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle minimum amount", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      const minAmount = 1n;

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          "MIN_ORDER",
          receiver.address,
          minAmount,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.not.be.reverted;
    });

    it("Should handle large amounts", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      const largeAmount = hre.ethers.parseEther("1000000"); // 1M ETH

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          "LARGE_ORDER",
          receiver.address,
          largeAmount,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          RELEASE_AFTER
        )
      ).to.not.be.reverted;
    });

    it("Should handle immediate release (releaseAfter = 0)", async function () {
      const { escrowTransaction, seller, receiver } = await loadFixture(deployEscrowTransactionFixture);

      await expect(
        escrowTransaction.connect(seller).createTransaction(
          "IMMEDIATE_ORDER",
          receiver.address,
          AMOUNT,
          hre.ethers.ZeroAddress,
          METADATA_URI,
          0 // Immediate release
        )
      ).to.not.be.reverted;

      const transaction = await escrowTransaction.getTransactionByOrderId("IMMEDIATE_ORDER");
      expect(transaction.releaseAfter).to.equal(0);
    });
  });

  describe("Status Transitions", function () {
    it("Should transition from PENDING to PAID", async function () {
      const { escrowTransaction, buyer } = await loadFixture(deployWithTransactionFixture);

      const transactionBefore = await escrowTransaction.getTransactionByOrderId(ORDER_ID);
      expect(transactionBefore.status).to.equal(Status.PENDING);

      const escrowAddress = hre.ethers.Wallet.createRandom().address;
      await escrowTransaction.updateTransactionWithEscrow(ORDER_ID, buyer.address, escrowAddress);

      const transactionAfter = await escrowTransaction.getTransactionByOrderId(ORDER_ID);
      expect(transactionAfter.status).to.equal(Status.PAID);
    });

    it("Should transition from PENDING to CANCELLED", async function () {
      const { escrowTransaction, seller } = await loadFixture(deployWithTransactionFixture);

      const transactionBefore = await escrowTransaction.getTransactionByOrderId(ORDER_ID);
      expect(transactionBefore.status).to.equal(Status.PENDING);

      await escrowTransaction.connect(seller).cancelTransaction(ORDER_ID);

      const transactionAfter = await escrowTransaction.getTransactionByOrderId(ORDER_ID);
      expect(transactionAfter.status).to.equal(Status.CANCELLED);
    });
  });
});