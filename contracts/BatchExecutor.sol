// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IERC20Batch {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

contract BatchExecutor {
    address public immutable factory;
    address public token;
    bytes32 public paymentsRoot;
    uint256 public totalAmount;
    address public refundAddress;
    uint256 public expiry;
    bool public initialized;

    uint256 public paidAmount;
    mapping(uint256 => bool) public paid;
    bool private entered;

    event Paid(uint256 indexed index, address indexed recipient, uint256 amount);
    event Refunded(uint256 amount);

    constructor() {
        factory = msg.sender;
        initialized = true; // The implementation itself cannot hold a batch.
    }

    function initialize(address token_, bytes32 root_, uint256 total_, address refund_, uint256 expiry_) external {
        require(msg.sender == factory, "factory only");
        require(!initialized, "already initialized");
        require(token_ != address(0) && refund_ != address(0), "zero address");
        require(root_ != bytes32(0) && total_ > 0, "empty batch");
        require(expiry_ > block.timestamp, "expired");
        token = token_;
        paymentsRoot = root_;
        totalAmount = total_;
        refundAddress = refund_;
        expiry = expiry_;
        initialized = true;
    }

    modifier nonReentrant() {
        require(!entered, "reentrant");
        entered = true;
        _;
        entered = false;
    }

    // Leaves are keccak256(abi.encode(index, recipient, amount)). Pair hashes are sorted.
    function execute(uint256 index, address recipient, uint256 amount, bytes32[] calldata proof)
        external nonReentrant
    {
        require(initialized, "not initialized");
        require(block.timestamp < expiry, "expired");
        require(!paid[index], "already paid");
        require(recipient != address(0) && amount > 0, "invalid payment");
        require(IERC20Batch(token).balanceOf(address(this)) >= totalAmount - paidAmount, "not funded");
        bytes32 leaf = keccak256(abi.encode(index, recipient, amount));
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        require(computed == paymentsRoot, "invalid proof");
        require(amount <= totalAmount - paidAmount, "exceeds total");
        paid[index] = true;
        paidAmount += amount;
        _transfer(recipient, amount);
        emit Paid(index, recipient, amount);
    }

    // Unpaid funds can only return to the owner address fixed at deployment.
    function refund() external nonReentrant {
        require(initialized, "not initialized");
        require(block.timestamp >= expiry || paidAmount == totalAmount, "batch active");
        uint256 balance = IERC20Batch(token).balanceOf(address(this));
        require(balance > 0, "empty balance");
        _transfer(refundAddress, balance);
        emit Refunded(balance);
    }

    function _transfer(address to, uint256 amount) private {
        require(to != address(this), "self transfer");
        uint256 beforeSelf = IERC20Batch(token).balanceOf(address(this));
        uint256 beforeRecipient = IERC20Batch(token).balanceOf(to);
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Batch.transfer.selector, to, amount)
        );
        // Nile USDT returns false even when it moves tokens. Check the actual deltas.
        require(ok && (data.length == 0 || data.length == 32), "transfer call failed");
        uint256 afterSelf = IERC20Batch(token).balanceOf(address(this));
        uint256 afterRecipient = IERC20Batch(token).balanceOf(to);
        require(beforeSelf == afterSelf + amount && afterRecipient == beforeRecipient + amount, "transfer amount mismatch");
    }
}

contract BatchFactory {
    address public immutable implementation;
    event BatchCreated(address indexed batch, bytes32 indexed salt);

    constructor() {
        implementation = address(new BatchExecutor());
    }

    function batchSalt(
        bytes32 batchId,
        address token,
        bytes32 root,
        uint256 total,
        address refundAddress,
        uint256 expiry
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(token, root, total, refundAddress, expiry, batchId));
    }

    function createBatch(
        bytes32 batchId,
        address token,
        bytes32 root,
        uint256 total,
        address refundAddress,
        uint256 expiry
    ) external returns (address batch) {
        bytes32 salt = batchSalt(batchId, token, root, total, refundAddress, expiry);
        // EIP-1167 creation code; TVM CREATE2 uses TRON's address derivation.
        bytes memory code = abi.encodePacked(
            hex"3d602d80600a3d3981f3",
            hex"363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3"
        );
        assembly {
            batch := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(batch != address(0), "clone deployment failed");
        BatchExecutor(batch).initialize(token, root, total, refundAddress, expiry);
        emit BatchCreated(batch, salt);
    }
}
