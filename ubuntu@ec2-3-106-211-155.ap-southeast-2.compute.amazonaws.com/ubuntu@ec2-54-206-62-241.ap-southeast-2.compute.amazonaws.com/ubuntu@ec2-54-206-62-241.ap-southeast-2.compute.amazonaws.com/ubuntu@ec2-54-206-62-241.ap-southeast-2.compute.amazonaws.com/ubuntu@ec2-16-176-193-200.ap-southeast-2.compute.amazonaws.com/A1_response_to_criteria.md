Assignment 1 - REST API Project - Response to Criteria
================================================

Overview
------------------------------------------------

- **Name:** Parastoo Yousefi Darestani
- **Student number:** n11621516
- **Application name:** PDF Converter
- **Two line description:** This app converts images and LaTeX files into PDFs, merges multiple PDFs into one, and records user history. It includes JWT-based login, CPU burn testing, and is deployed on AWS EC2 via Docker.


Core criteria
------------------------------------------------

### Containerise the app

- **ECR Repository name:** PDF_conv
- **Video timestamp:** 2:32
- **Relevant files:**
    - /Dockerfile

### Deploy the container

- **EC2 instance ID:** i-00a809b14e1eb08c0
- **Video timestamp:** 

### User login

- **One line description:** Hard-coded username.password list with JWT authentication (roles: admin or user)
- **Video timestamp:** 0:10
- **Relevant files:**
    - /server.js (lines ~ 14 - 18, 162 - 169)

### REST API

- **One line description:** REST API with clear endpoints (login, convert images, merge PDFs, convert LaTeX, history, health).
- **Video timestamp:**
- **Relevant files:**
    - /server.js (lines ~ 31 - 160)
    - /routes/history.js
    - /routes/auth.js

### Data types

- **One line description:** 
- **Video timestamp:**
- **Relevant files:**
    - 

#### First kind

- **One line description:** Uploaded files (images, PDFs, LaTeX)
- **Type:** unstructured
- **Rationale:** Binary files are processed directly into PDFs
- **Video timestamp:** 0:19
- **Relevant files:**
    - /server.js (image to PDF, LaTeX to PDF, merge PDFs)

#### Second kind

- **One line description:** User action history (operation, files, timestamp)
- **Type:** Structured
- **Rationale:** Needed for querying what operations users performed.
- **Video timestamp:** 2:05
- **Relevant files:**
  - routes/history.js

### CPU intensive task

 **One line description:** 
- **Video timestamp:** 
- **Relevant files:**
    - /server.js 

### CPU load testing

 **One line description:** 
- **Video timestamp:** 
- **Relevant files:**
    - /server.js

Additional criteria
------------------------------------------------

### Extensive REST API features

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### External API(s)

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Additional types of data

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Custom processing

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Infrastructure as code

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Web client

- **One line description:**
- **Video timestamp:**
- **Relevant files:**
    -   

### Upon request

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**