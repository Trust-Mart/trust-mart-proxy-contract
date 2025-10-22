// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./lib/Event.sol";
import "./lib/Error.sol";

contract EscrowImplementation is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ============ Constants ============
    uint256 public constant BIPS_DENOMINATOR = 10_000;

    // ============ State Variables ============
    address public factory;
    address public buyer;
    address public seller;
    address public token;
    uint256 public amount;
    string  public metadataUri;
    uint16  public platformFeeBips;
    address public feeCollector;
    uint256 public createdAt;
    uint256 public releaseAfter;
    string  public disputeReason;
    address public disputeRaisedBy;

    enum Status { 
        FUNDED, 
        RELEASED, 
        REFUNDED, 
        DISPUTED,
        RESOLVED 
    }
    
    Status public status;

    // ============ Modifiers ============
    modifier onlyFactory() {
        require(msg.sender == factory, Error.ADDRESS_IS_NOT_FACTORY());
        _;
    }

    modifier onlyBuyer() {
        require(msg.sender == buyer, Error.ADDRESS_IS_NOT_BUYER());
        _;
    }

    modifier onlySeller() {
        require(msg.sender == seller, Error.ADDRESS_IS_NOT_SELLER());
        _;
    }

    modifier onlyParty() {
        require(msg.sender == buyer || msg.sender == seller, Error.ADDRESS_IS_NOT_PARTY());
        _;
    }

    modifier inStatus(Status _status) {
        require(status == _status, Error.INVALID_STATUS());
        _;
    }

    // ============ Initializer ============
    function initialize(
        address _factory,
        address _buyer,
        address _seller,
        address _token,
        uint256 _amount,
        string memory _metadataUri,
        address _feeCollector,
        uint16  _platformFeeBips,
        uint256 _releaseAfter
    ) external initializer {
        __ReentrancyGuard_init();

        require(_factory != address(0), Error.FACTORY_ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        require(_buyer != address(0), Error.BUYER_ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        require(_seller != address(0), Error.SELLER_ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        require(_token != address(0), Error.TOKEN_ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        require(_amount > 0, Error.AMOUNT_CAN_NOT_BE_ZERO());
        require(_feeCollector != address(0), Error.FEE_COLLECTOR_ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        require(_platformFeeBips < BIPS_DENOMINATOR, Error.FEE_TOO_HIGH());

        factory = _factory;
        buyer = _buyer;
        seller = _seller;
        token = _token;
        amount = _amount;
        metadataUri = _metadataUri;
        feeCollector = _feeCollector;
        platformFeeBips = _platformFeeBips;
        releaseAfter = block.timestamp + _releaseAfter;
        createdAt = block.timestamp;
        status = Status.FUNDED;

        emit Event.EscrowInitialized(_buyer, _seller, _token, _amount, _metadataUri);
    }

    // ============ External Functions ============
function buyerRelease() external nonReentrant onlyBuyer inStatus(Status.FUNDED) {
    _releaseToSeller();
}

function sellerRefund() external nonReentrant onlySeller inStatus(Status.FUNDED) {
    _refundToBuyer();
}

function autoRelease() external nonReentrant inStatus(Status.FUNDED) {
    require(block.timestamp >= releaseAfter, Error.RELEASE_OF_FUNDS_IS_TOO_EARLY());
    _releaseToSeller();
}

function raiseDispute(string calldata reason) external onlyParty inStatus(Status.FUNDED) {
    require(bytes(reason).length > 0, Error.DISPUTE_REASON_REQUIRED());
    
    status = Status.DISPUTED;
    disputeReason = reason;
    disputeRaisedBy = msg.sender;

    emit Event.DisputeRaised(msg.sender, reason);
}

function resolveDispute(address winner) external onlyFactory nonReentrant inStatus(Status.DISPUTED) {
    require(winner == buyer || winner == seller, Error.INVALID_WINNER());
    
    status = Status.RESOLVED;
    
    uint256 fee = (amount * platformFeeBips) / BIPS_DENOMINATOR;
    uint256 netAmount = amount - fee;

    if (winner == seller) {
        IERC20(token).safeTransfer(feeCollector, fee);
        IERC20(token).safeTransfer(seller, netAmount);
        emit Event.FundsReleased(seller, netAmount, fee);
    } else {
        // Refund buyer without fee
        IERC20(token).safeTransfer(buyer, amount);
        emit Event.FundsRefunded(buyer, amount);
    }

    emit Event.DisputeResolved(winner, netAmount, fee);
}

// Internal functions remain the same
function _releaseToSeller() internal {
    status = Status.RELEASED;
    
    uint256 fee = (amount * platformFeeBips) / BIPS_DENOMINATOR;
    uint256 netAmount = amount - fee;

    IERC20(token).safeTransfer(feeCollector, fee);
    IERC20(token).safeTransfer(seller, netAmount);

    emit Event.FundsReleased(seller, netAmount, fee);
}

function _refundToBuyer() internal {
    status = Status.REFUNDED;
    IERC20(token).safeTransfer(buyer, amount);
    emit Event.FundsRefunded(buyer, amount);
}

    // ============ View Functions ============
    function getBasicInfo() external view returns (
        address _buyer,
        address _seller,
        address _token,
        uint256 _amount,
        Status  _status,
        uint256 _releaseAfter
    ) {
        return (buyer, seller, token, amount, status, releaseAfter);
    }

    function getFeeInfo() external view returns (
        uint16  _platformFeeBips,
        address _feeCollector,
        uint256 _feeAmount,
        uint256 _netAmount
    ) {
        uint256 fee = (amount * platformFeeBips) / BIPS_DENOMINATOR;
        return (platformFeeBips, feeCollector, fee, amount - fee);
    }

    function getDisputeInfo() external view returns (
        bool    hasDispute,
        address raisedBy,
        string memory reason
    ) {
        return (
            status == Status.DISPUTED,
            disputeRaisedBy,
            disputeReason
        );
    }

    function getTimestamps() external view returns (
        uint256 _createdAt,
        uint256 _releaseAfter,
        uint256 _timeLeft
    ) {
        uint256 timeLeft = 0;
        if (block.timestamp < releaseAfter && status == Status.FUNDED) {
            timeLeft = releaseAfter - block.timestamp;
        }
        return (createdAt, releaseAfter, timeLeft);
    }

    function getBalance() external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function canAutoRelease() external view returns (bool) {
        return block.timestamp >= releaseAfter && status == Status.FUNDED;
    }

    function isActive() external view returns (bool) {
        return status == Status.FUNDED;
    }

    function getStatusString() external view returns (string memory) {
        if (status == Status.FUNDED) {
            return "ACTIVE";
        } else if (status == Status.RELEASED) {
            return "RELEASED";
        } else if (status == Status.REFUNDED) {
            return "REFUNDED";
        } else if (status == Status.DISPUTED) {
            return "DISPUTED";
        } else if (status == Status.RESOLVED) {
            return "RESOLVED";
        }
        return "UNKNOWN";
    }
}