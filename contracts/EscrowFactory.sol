// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./EscrowImplementation.sol";
import "./lib/Event.sol";
import "./lib/Error.sol";

contract EscrowFactory is Initializable, ReentrancyGuardUpgradeable {
    using Clones for address;
    using SafeERC20 for IERC20;

    // ============ State Variables ============
    address public escrowImplementation;
    address public feeCollector;
    address public arbitrator;
    uint16 public defaultFeeBips;
    uint256 public totalEscrowsCreated;
    uint256 public totalVolume;

    mapping(string => address) public orderEscrow;
    mapping(address => uint256) public userEscrowCount;
    mapping(EscrowImplementation.Status => uint256) public statusCounts;

    address[] public allEscrows;

    // ============ Modifiers ============
    modifier notZeroAddress(address _address) {
        require(_address != address(0), Error.ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        _;
    }

    modifier validFee(uint16 _feeBips) {
        require(_feeBips < 10_000, Error.FEE_TOO_HIGH());
        _;
    }

    // ============ Constructor ============
    function initialize(
        address _implementation, 
        address _feeCollector, 
        address _arbitrator, 
        uint16 _feeBips
    ) public initializer
    notZeroAddress(_implementation) 
      notZeroAddress(_feeCollector) 
      notZeroAddress(_arbitrator) 
      validFee(_feeBips) {
        __ReentrancyGuard_init();

        escrowImplementation = _implementation;
        feeCollector = _feeCollector;
        arbitrator = _arbitrator;
        defaultFeeBips = _feeBips;
    }

    // ============ External Functions ============
    function createEscrow(
        string calldata orderId,
        address seller,
        address token,
        uint256 amount,
        string calldata metadataUri,
        uint256 releaseAfter
    ) external nonReentrant returns (address) {
        require(seller != address(0), Error.SELLER_ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        require(token != address(0), Error.TOKEN_ADDRESS_CAN_NOT_BE_ADDRESS_ZERO());
        require(amount > 0, Error.AMOUNT_CAN_NOT_BE_ZERO());
        require(bytes(orderId).length > 0, Error.ORDER_ID_EMPTY());
        require(orderEscrow[orderId] == address(0), Error.ORDER_EXISTS());

        // Check allowance and balance
        IERC20 tokenContract = IERC20(token);
        require(
            tokenContract.allowance(msg.sender, address(this)) >= amount,
            Error.INSUFFICIENT_ALLOWANCE()
        );
        require(
            tokenContract.balanceOf(msg.sender) >= amount,
            Error.INSUFFICIENT_BALANCE()
        );

        // Create clone
        address clone = Clones.clone(escrowImplementation);
        
        // Transfer tokens to clone
        tokenContract.safeTransferFrom(msg.sender, clone, amount);

        // Initialize escrow
        EscrowImplementation(clone).initialize(
            address(this),
            msg.sender,
            seller,
            token,
            amount,
            metadataUri,
            feeCollector,
            defaultFeeBips,
            releaseAfter
        );

        // Update state
        orderEscrow[orderId] = clone;
        userEscrowCount[msg.sender]++;
        userEscrowCount[seller]++;
        totalEscrowsCreated++;
        totalVolume += amount;
        statusCounts[EscrowImplementation.Status.FUNDED]++;
        allEscrows.push(clone);

        emit Event.EscrowCreated(clone, orderId, msg.sender, seller, token, amount);
        return clone;
    }

    function resolveDispute(address escrowAddress, address winner) external nonReentrant {
        require(msg.sender == arbitrator, Error.ADDRESS_IS_NOT_ARBITRATOR());
        EscrowImplementation escrow = EscrowImplementation(escrowAddress);
        require(escrow.factory() == address(this), Error.ADDRESS_IS_NOT_ESCROW());
        
        EscrowImplementation.Status oldStatus = escrow.status();
        escrow.resolveDispute(winner);
        
        // Update status counts - use unchecked to prevent overflow
        unchecked {
            if (statusCounts[oldStatus] > 0) {
                statusCounts[oldStatus]--;
            }
            statusCounts[EscrowImplementation.Status.RESOLVED]++;
        }
    }

    function updateFeeCollector(address newFeeCollector) external notZeroAddress(newFeeCollector) {
        // In production: add onlyOwner modifier
        feeCollector = newFeeCollector;
        emit Event.FeeCollectorUpdated(newFeeCollector);
    }

    function updateArbitrator(address newArbitrator) external notZeroAddress(newArbitrator) {
        // In production: add onlyOwner modifier
        arbitrator = newArbitrator;
        emit Event.ArbitratorUpdated(newArbitrator);
    }

    function updatePlatformFee(uint16 newFeeBips) external validFee(newFeeBips) {
        // In production: add onlyOwner modifier
        defaultFeeBips = newFeeBips;
        emit Event.PlatformFeeUpdated(newFeeBips);
    }

    // ============ View Functions ============
    function getEscrowAddress(string calldata orderId) external view returns (address) {
        return orderEscrow[orderId];
    }

    function getTotalEscrows() external view returns (uint256) {
        return allEscrows.length;
    }

    function getUserEscrowCount(address user) external view returns (uint256) {
        return userEscrowCount[user];
    }

    function getStatusCounts() external view returns (
        uint256 funded,
        uint256 released,
        uint256 refunded,
        uint256 disputed,
        uint256 resolved
    ) {
        return (
            statusCounts[EscrowImplementation.Status.FUNDED],
            statusCounts[EscrowImplementation.Status.RELEASED],
            statusCounts[EscrowImplementation.Status.REFUNDED],
            statusCounts[EscrowImplementation.Status.DISPUTED],
            statusCounts[EscrowImplementation.Status.RESOLVED]
        );
    }

    function getFactoryStats() external view returns (
        uint256 _totalEscrows,
        uint256 _totalVolume,
        uint16 _feeBips,
        address _feeCollector,
        address _arbitrator
    ) {
        return (
            totalEscrowsCreated,
            totalVolume,
            defaultFeeBips,
            feeCollector,
            arbitrator
        );
    }

    function isKnownEscrow(address escrowAddress) external view returns (bool) {
        for (uint i = 0; i < allEscrows.length; i++) {
            if (allEscrows[i] == escrowAddress) {
                return true;
            }
        }
        return false;
    }

    function getUserEscrows(address user) external view returns (address[] memory) {
        uint256 count = 0;
        for (uint i = 0; i < allEscrows.length; i++) {
            EscrowImplementation escrow = EscrowImplementation(allEscrows[i]);
            (address _buyer, address _seller, , , , ) = escrow.getBasicInfo();
            if (_buyer == user || _seller == user) {
                count++;
            }
        }

        address[] memory userEscrows = new address[](count);
        uint256 index = 0;
        for (uint i = 0; i < allEscrows.length; i++) {
            EscrowImplementation escrow = EscrowImplementation(allEscrows[i]);
            (address _buyer, address _seller, , , , ) = escrow.getBasicInfo();
            if (_buyer == user || _seller == user) {
                userEscrows[index] = allEscrows[i];
                index++;
            }
        }
        return userEscrows;
    }

    function getEscrowsByStatus(EscrowImplementation.Status statusFilter) external view returns (address[] memory) {
        uint256 count = 0;
        for (uint i = 0; i < allEscrows.length; i++) {
            if (EscrowImplementation(allEscrows[i]).status() == statusFilter) {
                count++;
            }
        }

        address[] memory escrows = new address[](count);
        uint256 index = 0;
        for (uint i = 0; i < allEscrows.length; i++) {
            if (EscrowImplementation(allEscrows[i]).status() == statusFilter) {
                escrows[index] = allEscrows[i];
                index++;
            }
        }
        return escrows;
    }
}