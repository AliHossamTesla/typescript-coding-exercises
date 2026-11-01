import { DSU, GenericDSU } from "../src/index.js";

const dsu = new DSU(6);
dsu.union(0, 1);
dsu.union(1, 2);
dsu.union(3, 4);
console.log("connected(0, 2):", dsu.connected(0, 2)); // true
console.log("connected(0, 3):", dsu.connected(0, 3)); // false
console.log("size(2):", dsu.size(2)); // 3
console.log("count:", dsu.count); // 3: {0,1,2} {3,4} {5}
console.log("union(2, 0) again:", dsu.union(2, 0)); // false
console.log("maxDepth:", dsu.maxDepth()); // 1
dsu.clear();
console.log("count after clear:", dsu.count); // 6

const friends = new GenericDSU(["alice", "bob", "carol"]);
friends.union("alice", "bob");
console.log("alice ~ bob:", friends.connected("alice", "bob")); // true
console.log("groups:", friends.count); // 2
