// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library Event {
    event EscrowInitialized(
        address indexed buyer, 
        address indexed seller, 
        address token, 
        uint256 amount, 
        string metadataUri
    );
    event FundsReleased(address indexed to, uint256 netAmount, uint256 feeAmount);
    event FundsRefunded(address indexed to, uint256 amount);
    event DisputeRaised(address indexed raisedBy, string reason);
    event DisputeResolved(address indexed winner, uint256 netAmount, uint256 feeAmount);
    event EscrowCreated(
        address indexed escrow, 
        string orderId, 
        address buyer, 
        address seller, 
        address token, 
        uint256 amount
    );
    event FeeCollectorUpdated(address newFeeCollector);
    event ArbitratorUpdated(address newArbitrator);
    event PlatformFeeUpdated(uint16 newFeeBips);
}