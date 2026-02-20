# Multi-scale Image Projection

A multi-scale image projection visualization system based on FastAPI and React, supporting interactive browsing and analysis of large-scale image data.

## System Requirements

- Python 3.11+
- Node.js 18+
- Conda (recommended) or pip

## Installation

### Backend Installation (Python)

#### Method: Using Conda (Recommended)

1. **Install Conda**
   - Download and install [Anaconda](https://www.anaconda.com/products/distribution) or [Miniconda](https://docs.conda.io/en/latest/miniconda.html)

2. **Create and activate environment**
   ```bash
   # Create conda environment
   conda env create -f environment.yml
   
   # Activate environment
   conda activate multiscale
   ```

### Frontend Installation (Node.js)
1. **Install node.js**
https://nodejs.org/en/download


2. **Install Node.js dependencies**
   ```bash
   npm install
   ```

## Running the Project

### 1. Start Backend Service

```bash
# Make sure conda environment is activated
conda activate multiscale

# Start FastAPI server
python main.py
```

Backend service will start at `http://localhost:8000`

### 2. Start Frontend Service

In a new terminal window:

```bash
# Start React development server
npm start
```

Frontend application will start at `http://localhost:3000`

### 3. Access the Application

- **Frontend Interface**: http://localhost:3000
- **Backend API**: http://localhost:8000

## Data Preparation

Before using the application, you need to prepare the following data files:
An example here: 

1. **Zarr data file**: Compressed(zip) file containing image data.
2. **Raw data(csv)**: File containing spatial and umap position, clustering infomation for each tiles.
3. **Zooming Cluster(csv)**: File containing hierarchical clustering information.
4. **Channel List(csv)**: File containing the channels in order.
5. **Features(npy)**: High dim features from model.
6. **Meta Data(csv)**: Meta Data for each tile.

### Zarr Image (Zip): named as output.zarr.zip 

### Raw Data and Zooming Cluster

In Raw Data, upload 'data_raw.csv'
In Zooming cluster, upload 'cluster_multilevel_hierarchy.csv' 

To generate 'data_raw.csv' and 'cluster_multilevel_hierarchy.csv', you can run the python script `build_multilevel_clusters.py`. The input csv file for the python script should contain the following columns in order:

- `cellid`: Unique identifier for each cell
- `X_centroid`: X coordinate of cell centroid
- `Y_centroid`: Y coordinate of cell centroid  
- `clustering`: Clusters for the whole data 
- `umap2_x`: UMAP 2D X coordinate
- `umap2_y`: UMAP 2D Y coordinate
- `umap3_x`: UMAP 3D X coordinate
- `umap3_y`: UMAP 3D Y coordinate
- `umap3_z`: UMAP 3D Z coordinate

### Channel List (CSV)
Two columns: `channel_id`, `channel_name`

### Features (npy)
High-dim features from vit(or other) model, each tile is a high-dimensional vector, and the tiles are stored sequentially.

## LLM 
A request template is provided below the prompt. Please adapt the data description in the template to make it appropriate. 

Also, to use llm, you should add 'hf_token.txt' under the folder 'server/secrets' which include the token to request llm.

We give an example result formated as 'json' file called 'cluster_labels.json' under folder 'public'. If you don't have access to llm, you can just put it under the public.

## License

MIT License