// import find from "local-devices";
//
// find().then((devices) => {
//   console.log(devices);
// });

import netList from "network-list";

netList.scan({}, (err, arr) => {
  console.log(arr.filter((i) => i.alive));
  // Output: [{ ip: '192.168.0.10', mac: '...', hostname: '...', vendor: '...' }, ...]
});

