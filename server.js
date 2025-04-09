const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');

const server = express();
server.use(cors());
server.use(bodyParser.json());

//Conexão com a BD
const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "1234",
    database: "heralert",
});

db.connect(function (error) {
    if (error) {
        console.error("Erro ao conectar a DB:", error);
    } else {
        console.log("Conectado a DB");
    }
});

//Esatbelecer porta
server.listen(8085, function check(error) {
    if (error) {
        console.log("Erro", error);
    }
    else {
        console.log("Começou 8085");
    }
});

//View todos users
server.get("/api/users", (req, res) => {
    const sql = "SELECT * FROM users";
    db.query(sql, function (error, result) {
        if (error) {
            console.error("Erro ao consultar a tabela 'users':", error);
            res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
        } else {
            res.send({ status: true, data: result });
        }
    });
});

//Login
server.post('/api/login', (req, res) => {
    const { usernameOrEmail, password } = req.body;
    console.log("Tentativa de login com:", { usernameOrEmail, password });

    const sql = "SELECT * FROM users WHERE email = ? OR username = ?";
    db.query(sql, [usernameOrEmail, usernameOrEmail], (error, result) => {
        if (error) {
            console.error("Erro ao consultar a tabela 'users':", error);
            return res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
        }

        if (result.length === 0) {
            console.log("Usuário não encontrado:", usernameOrEmail); // Log de usuário não encontrado
            return res.status(401).send({ status: false, message: "Usuário não encontrado" });
        }

        const user = result[0];

        if (user.password !== password) {
            console.log("Senha incorreta para usuário:", user.username);
            return res.status(401).send({ status: false, message: "Senha incorreta" });
        }

        const { password_hash, ...userData } = user;
        res.send({ status: true, data: userData });
    });
});

//Cadastro
server.post('/api/register', (req, res) => {
    const { username, name, email, password } = req.body;
    console.log("Tentativa de cadastro com:", { username, name, email });

    const checkUserSql = "SELECT * FROM users WHERE username = ? OR email = ?";
    db.query(checkUserSql, [username, email], (error, result) => {
        if (error) {
            console.error("Erro ao consultar a tabela 'users':", error);
            return res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
        }

        if (result.length > 0) {
            const existingUser = result[0];
            if (existingUser.email === email) {
                return res.status(409).send({ status: false, field: 'email', message: "Email já cadastrado" });
            }
            if (existingUser.username === username) {
                return res.status(409).send({ status: false, field: 'username', message: "Usuário já cadastrado" });
            }
        }

        const sql = "INSERT INTO users (username, name, email, password) VALUES (?, ?, ?, ?)";
        db.query(sql, [username, name, email, password], (error) => {
            if (error) {
                console.error("Erro ao inserir usuário:", error);
                return res.status(500).send({ status: false, message: "Erro ao cadastrar usuário" });
            }

            console.log("Usuário cadastrado com sucesso:", { username, name, email });
            res.send({ status: true, message: "Usuário cadastrado com sucesso" });
        });
    });
});
