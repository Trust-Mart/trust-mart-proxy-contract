// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./lib/Event.sol";
import "./lib/Error.sol";

contract EscrowTransaction {
    enum Status {
        PENDING,
        PAID,
        CANCELLED
    }

    struct TransactionDetails {
        address buyer;
        address receiver;
        address escrowAddress;
        uint256 amount;
        address token;
        string metadataUri;
        Status status;
        string orderId;
        uint256 createdAt;
        uint256 releaseAfter;
    }

    mapping(address => TransactionDetails[]) public usersTransactions;
    
    mapping(string => address) public orderToSeller;
    mapping(string => uint256) public orderToTransactionIndex;

    modifier notZeroAddress(address _address) {
        require(_address != address(0), Error.ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        _;
    }

    modifier validOrderId(string calldata orderId) {
        require(bytes(orderId).length > 0, Error.ORDER_ID_EMPTY());
        require(orderToSeller[orderId] == address(0), Error.ORDER_EXISTS());
        _;
    }

    // ============ External Functions ============

    /**
     * @notice Create a new transaction details
     * @param orderId Unique identifier for the transaction (will be used in createEscrow)
     * @param receiver The address that will receive the payment (seller)
     * @param amount The amount to be paid
     * @param token The token address (address(0) for native currency)
     * @param metadataUri URI for transaction metadata
     * @param releaseAfter Timestamp after which funds can be released (0 for immediate)
     */
    function createTransaction(
        string calldata orderId,
        address receiver,
        uint256 amount,
        address token,
        string calldata metadataUri,
        uint256 releaseAfter
    ) external validOrderId(orderId) notZeroAddress(receiver) {
        require(amount > 0, Error.AMOUNT_CAN_NOT_BE_ZERO());
        require(bytes(metadataUri).length > 0, Error.METADATA_URI_IS_EMPTY());

        TransactionDetails memory newTransaction = TransactionDetails({
            buyer: address(0),
            receiver: receiver,
            escrowAddress: address(0),
            amount: amount,
            token: token,
            metadataUri: metadataUri,
            status: Status.PENDING,
            orderId: orderId,
            createdAt: block.timestamp,
            releaseAfter: releaseAfter
        });

        usersTransactions[msg.sender].push(newTransaction);
        uint256 transactionIndex = usersTransactions[msg.sender].length - 1;
        
        orderToTransactionIndex[orderId] = transactionIndex;
        orderToSeller[orderId] = msg.sender;

        emit Event.TransactionCreated(
            msg.sender,
            receiver,
            orderId,
            amount,
            token,
            metadataUri,
            releaseAfter
        );
    }

    /**
     * @notice Update transaction with escrow address and buyer (called after createEscrow from frontend)
     * @param orderId The order ID to update
     * @param buyer The buyer address who paid
     * @param escrowAddress The escrow contract address created
     */
    function updateTransactionWithEscrow(
        string calldata orderId,
        address buyer,
        address escrowAddress
    ) external {
        require(bytes(orderId).length > 0, Error.ORDER_ID_EMPTY());
        require(orderToSeller[orderId] != address(0), Error.ORDER_DOES_NOT_EXIST());
        require(buyer != address(0), Error.ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        require(escrowAddress != address(0), Error.ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        
        address seller = orderToSeller[orderId];
        uint256 transactionIndex = orderToTransactionIndex[orderId];
        TransactionDetails storage transaction = usersTransactions[seller][transactionIndex];
        
        require(transaction.status == Status.PENDING, Error.TRANSACTION_ALREADY_PROCESSED());
        require(transaction.buyer == address(0), Error.TRANSACTION_ALREADY_PAID());

        // Update transaction details
        transaction.buyer = buyer;
        transaction.escrowAddress = escrowAddress;
        transaction.status = Status.PAID;

        // Also store transaction for buyer
        usersTransactions[buyer].push(transaction);

        // Cast enum to uint8 for event emission
        emit Event.TransactionUpdated(orderId, escrowAddress, uint8(Status.PAID));
    }

    /**
     * @notice Cancel a pending transaction
     * @param orderId The order ID to cancel
     */
    function cancelTransaction(string calldata orderId) external {
        require(bytes(orderId).length > 0, Error.ORDER_ID_EMPTY());
        require(orderToSeller[orderId] != address(0), Error.ORDER_DOES_NOT_EXIST());
        
        address seller = orderToSeller[orderId];
        require(msg.sender == seller, Error.ADDRESS_IS_NOT_SELLER());

        uint256 transactionIndex = orderToTransactionIndex[orderId];
        TransactionDetails storage transaction = usersTransactions[seller][transactionIndex];
        
        require(transaction.status == Status.PENDING, Error.TRANSACTION_ALREADY_PROCESSED());
        require(transaction.buyer == address(0), Error.TRANSACTION_ALREADY_PAID());

        transaction.status = Status.CANCELLED;

        // Cast enum to uint8 for event emission
        emit Event.TransactionUpdated(orderId, address(0), uint8(Status.CANCELLED));
    }

    // ============ View Functions ============

    /**
     * @notice Get all transactions for a user
     * @param user The user address
     * @return Array of transaction details
     */
    function getUserTransactions(address user) external view returns (TransactionDetails[] memory) {
        return usersTransactions[user];
    }

    /**
     * @notice Get transaction by order ID
     * @param orderId The order ID
     * @return Transaction details
     */
    function getTransactionByOrderId(string calldata orderId) external view returns (TransactionDetails memory) {
        require(bytes(orderId).length > 0, Error.ORDER_ID_EMPTY());
        require(orderToSeller[orderId] != address(0), Error.ORDER_DOES_NOT_EXIST());
        
        address seller = orderToSeller[orderId];
        uint256 transactionIndex = orderToTransactionIndex[orderId];
        return usersTransactions[seller][transactionIndex];
    }

    /**
     * @notice Get user's transactions by status
     * @param user The user address
     * @param status The status to filter by
     * @return Array of transaction details with the specified status
     */
    function getUserTransactionsByStatus(
        address user, 
        Status status
    ) external view returns (TransactionDetails[] memory) {
        TransactionDetails[] memory allTransactions = usersTransactions[user];
        uint256 count = 0;
        
        // First, count how many match the status
        for (uint256 i = 0; i < allTransactions.length; i++) {
            if (allTransactions[i].status == status) {
                count++;
            }
        }
        
        // Then, create array with matching transactions
        TransactionDetails[] memory filtered = new TransactionDetails[](count);
        uint256 index = 0;
        
        for (uint256 i = 0; i < allTransactions.length; i++) {
            if (allTransactions[i].status == status) {
                filtered[index] = allTransactions[i];
                index++;
            }
        }
        
        return filtered;
    }

    /**
     * @notice Check if an order exists and is pending
     * @param orderId The order ID to check
     * @return exists Whether the order exists and is pending
     */
    function isOrderPending(string calldata orderId) external view returns (bool) {
        if (bytes(orderId).length == 0 || orderToSeller[orderId] == address(0)) {
            return false;
        }
        
        address seller = orderToSeller[orderId];
        uint256 transactionIndex = orderToTransactionIndex[orderId];
        TransactionDetails memory transaction = usersTransactions[seller][transactionIndex];
        
        return transaction.status == Status.PENDING && transaction.buyer == address(0);
    }

    /**
     * @notice Get transaction count for a user
     * @param user The user address
     * @return Number of transactions
     */
    function getTransactionCount(address user) external view returns (uint256) {
        return usersTransactions[user].length;
    }

    /**
     * @notice Get basic transaction info for createEscrow parameters
     * @param orderId The order ID
     * @return seller The seller address
     * @return receiver The receiver address
     * @return amount The transaction amount
     * @return token The token address
     * @return metadataUri The metadata URI
     * @return releaseAfter The release timestamp
     */
    function getTransactionForEscrow(
        string calldata orderId
    ) external view returns (
        address seller,
        address receiver,
        uint256 amount,
        address token,
        string memory metadataUri,
        uint256 releaseAfter
    ) {
        require(bytes(orderId).length > 0, Error.ORDER_ID_EMPTY());
        require(orderToSeller[orderId] != address(0), Error.ORDER_DOES_NOT_EXIST());
        
        address transactionSeller = orderToSeller[orderId];
        uint256 transactionIndex = orderToTransactionIndex[orderId];
        TransactionDetails memory transaction = usersTransactions[transactionSeller][transactionIndex];
        
        return (
            transactionSeller, // seller for createEscrow
            transaction.receiver, // receiver for createEscrow
            transaction.amount,
            transaction.token,
            transaction.metadataUri,
            transaction.releaseAfter
        );
    }
}