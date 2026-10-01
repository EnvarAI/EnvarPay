// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Test-only, immutable task escrow inspired by ERC-8183.
/// @dev Not an audited implementation or a claim of full ERC-8183 compatibility.
/// Terms are fixed at creation; no hooks, upgrades, admin, fees, or arbitration.
contract TaskEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum Status { Open, Funded, Submitted, Completed, Rejected, Expired }
    struct Job {
        address client;
        address provider;
        address evaluator;
        uint256 budget;
        uint256 deadline;
        bytes32 terms;
        bytes32 deliverable;
        Status status;
    }
    IERC20 public immutable token;
    mapping(bytes32 => Job) public jobs;
    event Created(bytes32 indexed id, address client, address provider, address evaluator, uint256 budget, uint256 deadline, bytes32 terms);
    event Funded(bytes32 indexed id);
    event Submitted(bytes32 indexed id, bytes32 deliverable);
    event Completed(bytes32 indexed id, bytes32 reason);
    event Rejected(bytes32 indexed id, bytes32 reason);
    event Expired(bytes32 indexed id);

    constructor(address paymentToken) {
        require(paymentToken != address(0), "zero token");
        token = IERC20(paymentToken);
    }
    function create(bytes32 id, address provider, address evaluator, uint256 budget, uint256 deadline, bytes32 terms) external {
        require(id != bytes32(0) && jobs[id].client == address(0), "duplicate id");
        require(provider != address(0) && evaluator != address(0), "zero role");
        require(provider != msg.sender, "same buyer/seller");
        require(budget > 0 && deadline > block.timestamp && terms != bytes32(0), "invalid terms");
        jobs[id] = Job(msg.sender, provider, evaluator, budget, deadline, terms, bytes32(0), Status.Open);
        emit Created(id, msg.sender, provider, evaluator, budget, deadline, terms);
    }
    function fund(bytes32 id, uint256 expectedBudget) external nonReentrant {
        Job storage j = jobs[id];
        require(msg.sender == j.client && j.status == Status.Open, "not open client");
        require(block.timestamp < j.deadline && expectedBudget == j.budget, "terms changed/expired");
        j.status = Status.Funded;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(j.client, address(this), j.budget);
        require(token.balanceOf(address(this)) == beforeBalance + j.budget, "non-exact token");
        emit Funded(id);
    }
    function submit(bytes32 id, bytes32 deliverable) external {
        Job storage j = jobs[id];
        require(msg.sender == j.provider && j.status == Status.Funded, "not funded provider");
        require(block.timestamp < j.deadline && deliverable != bytes32(0), "expired/empty");
        j.deliverable = deliverable;
        j.status = Status.Submitted;
        emit Submitted(id, deliverable);
    }
    function complete(bytes32 id, bytes32 reason) external nonReentrant {
        Job storage j = jobs[id];
        require(msg.sender == j.evaluator && j.status == Status.Submitted, "not submitted evaluator");
        require(block.timestamp < j.deadline, "expired");
        j.status = Status.Completed;
        token.safeTransfer(j.provider, j.budget);
        emit Completed(id, reason);
    }
    function reject(bytes32 id, bytes32 reason) external nonReentrant {
        Job storage j = jobs[id];
        Status previous = j.status;
        if (previous == Status.Open) {
            require(msg.sender == j.client, "not client");
        } else {
            require((previous == Status.Funded || previous == Status.Submitted) && msg.sender == j.evaluator, "not active evaluator");
        }
        j.status = Status.Rejected;
        if (previous != Status.Open) token.safeTransfer(j.client, j.budget);
        emit Rejected(id, reason);
    }
    function refundExpired(bytes32 id) external nonReentrant {
        Job storage j = jobs[id];
        require(j.status == Status.Funded || j.status == Status.Submitted, "not active");
        require(block.timestamp >= j.deadline, "not expired");
        j.status = Status.Expired;
        token.safeTransfer(j.client, j.budget);
        emit Expired(id);
    }
}
