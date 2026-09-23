db = db.getSiblingDB("admin");
db.createUser({
  user: "admin",
  pwd: "TuPasswordFuerte",
  roles: [ { role: "root", db: "admin" } ]
});

// Crear usuario para NextAuth
db = db.getSiblingDB("mydb");
db.createUser({
  user: "nextauth",
  pwd: "nextauth123",
  roles: [ { role: "readWrite", db: "mydb" } ]
});
