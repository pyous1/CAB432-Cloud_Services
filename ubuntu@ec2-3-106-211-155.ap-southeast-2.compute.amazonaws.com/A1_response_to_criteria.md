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
- **Video timestamp:** 4:16
- **Relevant files:**
    - /Dockerfile

### Deploy the container

- **EC2 instance ID:** i-00a809b14e1eb08c0
- **Video timestamp:** 4:16 - 4:30

### User login

- **One line description:** Hard-coded username.password list with JWT authentication (roles: admin or user)
- **Video timestamp:** 0:00
- **Relevant files:**
    - /server.js 

### REST API

- **One line description:** REST API with clear endpoints (login, convert images, merge PDFs, convert LaTeX).
- **Video timestamp:** 0:26 - 2:23
- **Relevant files:**
    - /server.js 
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
- **Video timestamp:** 0:26
- **Relevant files:**
    - /server.js (image to PDF, LaTeX to PDF, merge PDFs)

#### Second kind

- **One line description:** User action history (operation, files, timestamp)
- **Type:** Structured
- **Rationale:** Needed for querying what operations users performed.
- **Video timestamp:** 
- **Relevant files:**
  - routes/history.js

### CPU intensive task

 **One line description:** Heavy watermarking 
- **Video timestamp:** 2:25 - 2:35
- **Relevant files:**
    - /server.js 

### CPU load testing

 **One line description:** Custom Node.js loadtest script repeatedly posts PDFs to /watermark-heavy
- **Video timestamp:** 4:08 - 4:16
- **Relevant files:**
    - /server.js

Additional criteria
------------------------------------------------

### Extensive REST API features

- **One line description:** Attempted - Only Admin is Authorised to use History
- **Video timestamp:**
- **Relevant files:**
    - Server.js
    - Auth.js


### External API(s)

- **One line description:** Attempted - Fetches an external PDF via Axios and re-uploads to S3
- **Video timestamp:** 4:01 - 4:08
- **Relevant files:**
    - server.js

### Additional types of data

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Custom processing

- **One line description:** Attempted - Watermarking on PDFs
- **Video timestamp:** 2:25 - 2:35
- **Relevant files:**
    - Server.js

### Infrastructure as code

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Web client

- **One line description:** Attempted - static HTML client(public/) demonstrates uploading and calling endpoints in browser
- **Video timestamp:** 2:37 - 4:00
- **Relevant files:**
    -   server.js

### Upon request

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**