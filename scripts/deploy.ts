const { ethers, upgrades } = require("hardhat");

async function main() {
  const TrustMartEscrow = await ethers.getContractFactory("EscrowImplementation");
  const escrowImpl = await upgrades.deployImplementation(TrustMartEscrow);
  console.log("✅ TrustMart Escrow implementation deployed at:", escrowImpl);

  const TrustMartFactory = await ethers.getContractFactory("EscrowFactory");

  const feeCollector = "0x3e940762B2d3EC049FF075064bED358720a9260B";
  const arbitrator = "0x3e940762B2d3EC049FF075064bED358720a9260B";
  const platformFeeBips = 10;

  const factoryProxy = await upgrades.deployProxy(
    TrustMartFactory,
    [escrowImpl, feeCollector, arbitrator, platformFeeBips],
    { initializer: "initialize" }
  );

  await factoryProxy.waitForDeployment();
  console.log("✅ TrustMartFactory proxy deployed at:", await factoryProxy.getAddress());
}

main()
  .then(() => console.log("Contract deployed successfully"))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });