// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// Local EVM tests only. Public testnet uses Circle's official Base Sepolia USDC.
contract MockUSDC is ERC20 {
    constructor() ERC20("Local test USDC", "USDC") { _mint(msg.sender, 100_000_000); }
    function decimals() public pure override returns (uint8) { return 6; }
}
