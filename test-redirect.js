fetch("http://localhost:3000/api/db", { redirect: "manual" }).then(res => { console.log(res.status); return res.text(); }).then(console.log).catch(console.error);
