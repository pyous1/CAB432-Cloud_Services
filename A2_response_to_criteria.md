Assignment 2 - Cloud Services Exercises - Response to Criteria
================================================

Instructions
------------------------------------------------
- Keep this file named A2_response_to_criteria.md, do not change the name
- Upload this file along with your code in the root directory of your project
- Upload this file in the current Markdown format (.md extension)
- Do not delete or rearrange sections.  If you did not attempt a criterion, leave it blank
- Text inside [ ] like [eg. S3 ] are examples and should be removed


Overview
------------------------------------------------

- **Name:** Dania Adil
- **Student number:** n11505524
- **Partner name (if applicable):** Parastoo Yousefi Darestani
- **Application name:** PDF Converter
- **Two line description:** We implemented a cloud-based PDF converter app that allows users to upload images, merge PDFs, and apply watermarks. It integrates multiple AWS services for persistence, caching, identity, and stateless operation.
- **EC2 instance name or ID:** i-08e9573e4c15f4f80

------------------------------------------------

### Core - First data persistence service

- **AWS service name:** Amazon S3
- **What data is being stored?:** Uploaded images and converted PDF files
- **Why is this service suited to this data?:** S3 provides highly durable object storage that is ideal for storing large binary files such as PDFs and images.
- **Why is are the other services used not suitable for this data?:** DynamoDB and RDS are optimised for structured data, not large unstructured files. 
- **Bucket/instance/table name:** my-pdf-storage-sydney
- **Video timestamp:** 0:00
- **Relevant files:**
    - server.js 
    - routes/history.js 

### Core - Second data persistence service

- **AWS service name:** DynamoDB
- **What data is being stored?:** Job history (user ID, file name, timestamps and the operation performed)
- **Why is this service suited to this data?:** DynamoDB provides scalable, low-latency key-value storage for rapidly recording job events.
- **Why is are the other services used not suitable for this data?:** S3 is inefficient for querying metadat, RDS requires more complex setup and isn't cost-effective for simple lookups. 
- **Bucket/instance/table name:** pdf-history
- **Video timestamp:** 0:27
- **Relevant files:** 
    - server.js
    - routes/history.js

### Third data service

- **AWS service name:**  RDS (PostgreSQL)
- **What data is being stored?:** Job details and analytics (user ID, filename, action type, status, created_at).
- **Why is this service suited to this data?:** RDS supports relational queries and aggregation, which is required for reporting (e.g. count jobs per user, filler by action).
- **Why is are the other services used not suitable for this data?:** DynamoDB lacks relational joins and filtering, while S3 is unstructured and unsuitable for SQL queries. 
- **Bucket/instance/table name:** A2-Group58 (instance name)
- **Video timestamp:** 0:45
- **Relevant files:**
    - server.js 

### S3 Pre-signed URLs

- **S3 Bucket names:** my-pdf-storage-sydney 
- **Video timestamp:** 1:35
- **Relevant files:**
    - server.js 

### In-memory cache

- **ElastiCache instance name:** pdfconverter
- **What data is being cached?:** Recently accessed job histories.
- **Why is this data likely to be accessed frequently?:** Users often check their job history multiple times, caching avoids repeated DynamoDB scans.
- **Video timestamp:** 1:57
- **Relevant files:**
    - server.js 

### Core - Statelessness

- **What data is stored within your application that is not stored in cloud data services?:** Temporary working files during PDF conversion/LaTeX compilation.
- **Why is this data not considered persistent state?:** They can be regenerated from the original source files in S3.
- **How does your application ensure data consistency if the app suddenly stops?:** Job events are logged in DynamoDB and RDS before task completion, allowing jobs to be retried without data loss. 
- **Relevant files:**
    - server.js 

### Graceful handling of persistent connections

- **Type of persistent connection and use:** REST API with client retries.
- **Method for handling lost connections:** Clients retry failed requests; cached DynamoDB results ensure consistent responses. 
- **Relevant files:**
    - server.js 


### Core - Authentication with Cognito

- **User pool name:** a2-group58
- **How are authentication tokens handled by the client?:** Tokens (idToken, accessToken) are returned from /auth/login and used in the Authorization header for API calls.
- **Video timestamp:** 2:30
- **Relevant files:**
    - server.js 

### Cognito multi-factor authentication

- **What factors are used for authentication:** Password and TOTP (google authenticator)
- **Video timestamp:** 3:17
- **Relevant files:**
    - server.js

### Cognito federated identities

- **Identity providers used:**
- **Video timestamp:**
- **Relevant files:**
    -

### Cognito groups

- **How are groups used to set permissions?:** Admins can list all S3 files while regular users can only see their own history. 
- **Video timestamp:** 4:17
- **Relevant files:**
    - server.js 

### Core - DNS with Route53

- **Subdomain**: pdfconverter58.cab432.com
- **Video timestamp:** 4:55

### Parameter store

- **Parameter names:** /n11621516/pdf_parameter
- **Video timestamp:** 5:48
- **Relevant files:**
    - server.js 

### Secrets manager

- **Secrets names:** n11621516-a2secret
- **Video timestamp:** 7:00
- **Relevant files:**
    - server.js 

### Infrastructure as code

- **Technology used:**
- **Services deployed:**
- **Video timestamp:**
- **Relevant files:**
    -

### Other (with prior approval only)

- **Description:**
- **Video timestamp:**
- **Relevant files:**
    -

### Other (with prior permission only)

- **Description:**
- **Video timestamp:**
- **Relevant files:**
    -