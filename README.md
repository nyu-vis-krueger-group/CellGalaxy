# Multi-scale Image Projection

A **multi-scale image projection visualization system** based on **FastAPI (backend)** and **React (frontend)**.  
The system supports interactive browsing and analysis of large-scale image datasets.

---

# System Requirements

- Python **3.11+**
- Node.js **18+**
- Conda (recommended) or pip

---

# Installation

## Backend Installation (Python)

### Using Conda (Recommended)

1. Install Conda

Download and install:

- https://www.anaconda.com/products/distribution
- https://docs.conda.io/en/latest/miniconda.html

2. Create environment

```bash
conda env create -f environment.yml
```

3. Activate environment

```bash
conda activate multiscale
```

---

## Frontend Installation (Node.js)

### Install Node.js

Download from:

https://nodejs.org/en/download

### Install dependencies

```bash
npm install
```

---

# Running the Project

## 1. Start Backend

```bash
conda activate multiscale
python main.py
```

Backend will run at:

```
http://localhost:8000
```

---

## 2. Start Frontend

Open a **new terminal** and run:

```bash
npm start
```

Frontend will run at:

```
http://localhost:3000
```

---

## 3. Access the System

Frontend Interface:

```
http://localhost:3000
```

Backend API:

```
http://localhost:8000
```

---

# Data Preparation

Before using the system, you need to prepare the following data files.

| File | Description |
|-----|-------------|
| Zarr Image | Image tiles stored in Zarr format |
| Raw Data | Spatial coordinates and embeddings for each tile |
| Zooming Cluster | Multi-level hierarchical clustering |
| Channel List | Channel names |
| Features | High-dimensional features |
| Meta Data | Optional metadata |

---

# Data Upload Order

Please upload files in the following order:

1. `output.zarr.zip`
2. `data_raw.csv`
3. `cluster_multilevel_hierarchy.csv`
4. `channel_list.csv`
5. `features.npy`
6. `metadata.csv` (optional)

---

# Zarr Image

Upload a compressed Zarr file:

```
output.zarr.zip
```

Requirements:

- Zarr must be **compressed as a ZIP file**
- Zarr version must be **zarr_format = 2**
- Data layout must follow:

```
[channel, image_num, size, size]
```

Example:

- **18 channels**
- **72,055 image tiles**
- **64 × 64 pixels per tile**

Example metadata:

```
shape = [18, 72055, 64, 64]
chunks = [18, 2025, 64, 64]
dtype = "<u2"
order = "C"
compressor = blosc + zstd
zarr_format = 2
```

This means the dataset contains **18 channels**, **72,055 tiles**, and each tile has a size of **64×64 pixels**.

---

# Raw Data and Zooming Cluster

Two files must be uploaded:

```
data_raw.csv
cluster_multilevel_hierarchy.csv
```

These files are generated using the script:

```
build_multilevel_clusters.py
```

---

# Generating data_raw.csv and cluster_multilevel_hierarchy.csv

To generate the required files, first prepare an input file named:

```
data.csv
```

Each row represents **one tile (or cell)**.

The file must contain the following columns:

| Column | Description |
|------|-------------|
| cellid | Unique identifier for each tile |
| X_centroid | X coordinate |
| Y_centroid | Y coordinate |
| clustering | Cluster label for the dataset |
| umap2_x | UMAP 2D X coordinate |
| umap2_y | UMAP 2D Y coordinate |
| umap3_x | UMAP 3D X coordinate |
| umap3_y | UMAP 3D Y coordinate |
| umap3_z | UMAP 3D Z coordinate |

Example format:

```
cellid,X_centroid,Y_centroid,clustering,umap2_x,umap2_y,umap3_x,umap3_y,umap3_z
```

---

## Running the Script

Place `data.csv` in the **same directory** as the script:

```
build_multilevel_clusters.py
```

Then run:

```bash
python build_multilevel_clusters.py
```

The script will generate:

```
data_raw.csv
cluster_multilevel_hierarchy.csv
```

These two files are required by the visualization system.

---

# Channel List

Upload a CSV file with two columns:

```
channel_id,channel_name
```

Example:

```
0,CD3
1,CD4
2,CD8
```

---

# Features (Optional)

File:

```
features.npy
```

Description:

- High-dimensional features extracted from a model
- Example models: **ViT or other embedding models**
- Each tile corresponds to **one feature vector**
- Tiles must be stored **in the same order as data_raw.csv**

---

# Meta Data (Optional)

A CSV file containing metadata for each tile.

---

# LLM Support

The system supports **LLM-based cluster annotation**.

To enable LLM:

Create the file:

```
server/secrets/hf_token.txt
```

The file should contain your **HuggingFace API token**.

---

## Prompt Template

A request template is provided below the prompt in the interface.  
You may adapt the data description in the template to match your dataset.

---

## Example Result

If you do not have access to LLM, you can directly provide the annotation file:

```
public/cluster_labels.json
```

---

# Interaction

- Click to select a tile. You can also use lasso or box selection to select areas.
- Hold **Shift** and use box or lasso, you can select two regions for comparison.
- **Option + Hover (on cluster title)** — View the cluster description.


# License

MIT License

