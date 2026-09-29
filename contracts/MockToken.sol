// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

contract MockToken {
    mapping(address => uint256) public balanceOf;
    bool public returnFalse;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setReturnFalse(bool value) external { returnFalse = value; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return !returnFalse;
    }
}
